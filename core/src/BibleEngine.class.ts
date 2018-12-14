import 'reflect-metadata';
import { createConnection, ConnectionOptions, Raw, EntityManager } from 'typeorm';
// import { deflate } from 'pako';

import {
    ENTITIES,
    BibleVersion,
    BiblePhrase,
    BibleBook,
    BibleSection,
    BibleCrossReference,
    DictionaryEntry,
    BibleParagraph
} from './entities';
import {
    parsePhraseId,
    generatePhraseId,
    generateContextRangeFromVersionRange,
    generateNormalizedReferenceFromVersionReference,
    isReferenceNormalized,
    generateRangeFromGenericSection,
    slimDownReferenceRange,
    slimDownCrossReference
} from './functions/reference.functions';
import {
    generatePhraseIdSql,
    generateReferenceIdSql,
    generateBookSectionsSql,
    generateParagraphSql
} from './functions/sql.functions';
import {
    stripUnnecessaryDataFromBibleContent,
    generateBibleDocument,
    convertBibleInputToBookPlaintext
} from './functions/content.functions';
import { generateMinimizedDbObject, generateMinimizedDbObjects } from './functions/utils.functions';
import {
    BibleBookPlaintext,
    IDictionaryEntry,
    IBibleVersion,
    IBibleReferenceRange,
    IBibleOutputRich,
    IBibleReferenceRangeNormalized,
    IBibleBook,
    BookWithContentForInput,
    PhraseModifiers,
    IBibleReference,
    IBibleReferenceNormalized,
    IBiblePhraseRef,
    IBibleContent,
    IBibleReferenceRangeQuery,
    IBibleReferenceVersion,
    IBibleReferenceRangeVersion,
    IBibleContentForInput,
    IBibleSection
} from './models';
import { getNormalizedVerseCount, getNormalizedChapterCountForOsisId } from './data/bibleMeta';

export class BibleEngine {
    currentVersion?: BibleVersion;
    currentVersionMetadata?: BibleBook[];
    pEntityManager: Promise<EntityManager>;

    constructor(dbConfig: ConnectionOptions, private remoteConfig?: { url: string }) {
        this.pEntityManager = createConnection({
            ...dbConfig,
            entities: ENTITIES,
            synchronize: true,
            logging: ['error']
        }).then(conn => conn.manager);
    }

    async addBookWithContent(bookInput: BookWithContentForInput) {
        const textData = convertBibleInputToBookPlaintext(bookInput.contents);
        bookInput.book.chaptersCount = [];
        for (const verses of textData.values()) {
            bookInput.book.chaptersCount.push(verses.size);
        }
        await this.addBook(bookInput.book);
        await this.addBibleContent(bookInput.contents, {
            book: bookInput.book,
            context: textData,
            modifierState: { quoteLevel: 0, indentLevel: 0 },
            columnModifierState: {},
            phraseStack: [],
            paragraphStack: [],
            sectionStack: [],
            currentPhraseNum: 0,
            currentNormalizedChapter: 0,
            currentNormalizedVerse: -1,
            sectionLevel: 0,
            recursionLevel: 0
        });
    }

    async addDictionaryEntry(dictionaryEntry: IDictionaryEntry) {
        const entityManager = await this.pEntityManager;
        entityManager.save(new DictionaryEntry(dictionaryEntry));
    }

    async addVersion(version: IBibleVersion) {
        const entityManager = await this.pEntityManager;
        return entityManager.save(new BibleVersion(version));
    }

    async finalizeVersion(versionId: number) {
        this.normalizeCrossReferencesForVersion(versionId);
    }

    async generateBookMetadata(book: BibleBook) {
        const entityManager = await this.pEntityManager;
        const metaData = await entityManager
            .createQueryBuilder(BiblePhrase, 'phrase')
            .addSelect('COUNT(DISTINCT phrase.versionVerseNum)', 'numVerses')
            .where({
                id: Raw(col =>
                    generatePhraseIdSql({ isNormalized: true, bookOsisId: book.osisId }, col)
                )
            })
            .orderBy('phrase.versionChapterNum')
            .groupBy('phrase.versionChapterNum')
            .getRawMany();
        book.chaptersCount = metaData.map(chapterMetaDb => chapterMetaDb.numVerses);
        return entityManager.save(book);
    }

    async getBooksForVersion(versionId: number) {
        const entityManager = await this.pEntityManager;
        return entityManager.find(BibleBook, {
            where: { versionId },
            order: { number: 'ASC' }
        });
    }

    async getDictionaryEntries(strong: string, dictionary?: string) {
        const entityManager = await this.pEntityManager;
        return entityManager.find(DictionaryEntry, { where: { strong, dictionary } });
    }

    async getFullDataForReferenceRange(
        rangeQuery: IBibleReferenceRangeQuery,
        stripUnnecessaryData = false
    ): Promise<IBibleOutputRich> {
        const entityManager = await this.pEntityManager;

        const version = await entityManager.findOne(BibleVersion, {
            where: { version: rangeQuery.version }
        });
        if (!version) {
            if (this.remoteConfig) {
                // TODO: refactor this out into a service
                const remoteData = await fetch(
                    this.remoteConfig.url + '/getFullDataForReferenceRange',
                    {
                        body: JSON.stringify(rangeQuery),
                        method: 'post',
                        headers: {
                            Accept: 'application/json',
                            'Content-Type': 'application/json'
                        }
                    }
                ).then(response => {
                    return response.json();
                });
                // TODO: properly handle error
                return remoteData;
            }
            throw new Error(`can't get formatted text: invalid version`);
        }

        const range: IBibleReferenceRangeVersion = { ...rangeQuery, versionId: version.id };

        const book = await this.getBookForVersionReference(range);
        if (!book) throw new Error(`can't get formatted text: invalid book`);

        const bookAbbreviations = await entityManager
            .find(BibleBook, {
                select: ['osisId', 'abbreviation']
            })
            .then(books => {
                const dict: { [index: string]: string } = {};
                for (const _book of books) {
                    dict[_book.osisId] = _book.abbreviation;
                }
                return dict;
            });

        const rangeNormalized = isReferenceNormalized(range)
            ? <IBibleReferenceRangeNormalized>range
            : await this.getNormalizedReferenceRange(range);

        const phrases = await this.getPhrases(rangeNormalized);
        const paragraphs = await entityManager
            .createQueryBuilder(BibleParagraph, 'paragraph')
            .where(
                generateParagraphSql(
                    { ...rangeNormalized, versionId: rangeNormalized.versionId! },
                    'paragraph'
                )
            )
            .orderBy('id')
            .getMany();
        const sections = await entityManager
            .createQueryBuilder(BibleSection, 'section')
            .where(generateBookSectionsSql(rangeNormalized, 'section'))
            // sections are inserted in order, so its safe to sort by generated id
            .orderBy('level')
            .addOrderBy('id')
            .getMany();

        const context: IBibleOutputRich['context'] = {};
        const contextRanges: IBibleOutputRich['contextRanges'] = {
            paragraph: {},
            sections: {},
            versionChapter: {},
            normalizedChapter: {}
        };

        if (phrases.length) {
            const firstPhraseId = phrases[0].id;
            const lastPhraseId = phrases[phrases.length - 1].id;
            for (const section of sections) {
                if (section.level > 1) {
                    let isSectionWithinParentLevel = false;
                    for (const parentSection of [
                        ...context[section.level - 1].includedSections,
                        context[section.level - 1].wrappingSection
                    ]) {
                        if (
                            parentSection &&
                            ((section.phraseStartId >= parentSection.phraseStartId &&
                                section.phraseStartId <= parentSection.phraseEndId) ||
                                (section.phraseEndId >= parentSection.phraseStartId &&
                                    section.phraseEndId <= parentSection.phraseEndId))
                        ) {
                            isSectionWithinParentLevel = true;
                            break;
                        }
                    }

                    if (!isSectionWithinParentLevel) continue;
                }

                if (!context[section.level]) {
                    context[section.level] = {
                        includedSections: [],
                        previousSections: [],
                        nextSections: []
                    };
                    contextRanges.sections[section.level] = {};
                }

                // check if this section wraps the entire range
                if (section.phraseStartId < firstPhraseId && section.phraseEndId > lastPhraseId)
                    context[section.level].wrappingSection = section;
                // check if this section starts or ends within the range
                else if (
                    (section.phraseStartId >= firstPhraseId &&
                        section.phraseStartId <= lastPhraseId) ||
                    (section.phraseEndId >= firstPhraseId && section.phraseEndId <= lastPhraseId)
                )
                    context[section.level].includedSections.push(section);
                // check if this section is before the range
                else if (section.phraseEndId < firstPhraseId)
                    context[section.level].previousSections.push(section);
                // check if this section is after the range
                else if (section.phraseStartId > lastPhraseId)
                    context[section.level].nextSections.push(section);
            }

            /* GENERATE CONTEXTRANGES */

            // paragraph context ranges
            for (const paragraph of paragraphs) {
                // paragraphs are sequentially sorted

                // the last paragraph before the range not included in the range will end up as
                // 'previousRange'
                if (paragraph.phraseEndId < firstPhraseId)
                    contextRanges.paragraph.previousRange = generateRangeFromGenericSection(
                        paragraph
                    );
                // the first paragraph after the range not included in the range will be set as
                // 'nextRange'
                else if (
                    paragraph.phraseStartId > lastPhraseId &&
                    !contextRanges.paragraph.nextRange
                )
                    contextRanges.paragraph.nextRange = generateRangeFromGenericSection(paragraph);
                else if (
                    paragraph.phraseStartId < firstPhraseId &&
                    paragraph.phraseEndId > lastPhraseId
                )
                    contextRanges.paragraph.completeRange = generateRangeFromGenericSection(
                        paragraph
                    );
                else if (
                    paragraph.phraseStartId < firstPhraseId &&
                    paragraph.phraseEndId >= firstPhraseId &&
                    paragraph.phraseEndId <= lastPhraseId
                )
                    contextRanges.paragraph.completeStartingRange = generateRangeFromGenericSection(
                        paragraph
                    );
                else if (
                    paragraph.phraseStartId >= firstPhraseId &&
                    paragraph.phraseStartId <= lastPhraseId &&
                    paragraph.phraseEndId > lastPhraseId
                )
                    contextRanges.paragraph.completeEndingRange = generateRangeFromGenericSection(
                        paragraph
                    );
            }
            if (
                paragraphs.length === 1 &&
                (paragraphs[0].phraseStartId < firstPhraseId ||
                    paragraphs[0].phraseEndId > lastPhraseId)
            ) {
                contextRanges.paragraph.completeRange = generateRangeFromGenericSection(
                    paragraphs[0]
                );
            }

            // context ranges for chapter (version & normalized)
            if (range.versionChapterNum) {
                if (range.versionChapterNum > 1)
                    contextRanges.versionChapter.previousRange = {
                        bookOsisId: book.osisId,
                        versionChapterNum: range.versionChapterNum - 1
                    };
                if (
                    (range.versionChapterEndNum &&
                        range.versionChapterEndNum < book.chaptersCount.length) ||
                    (!range.versionChapterEndNum &&
                        range.versionChapterNum &&
                        range.versionChapterNum < book.chaptersCount.length)
                ) {
                    contextRanges.versionChapter.nextRange = {
                        bookOsisId: book.osisId,
                        versionChapterNum: range.versionChapterEndNum
                            ? range.versionChapterEndNum + 1
                            : range.versionChapterNum! + 1
                    };
                }
                if (
                    (!range.versionChapterEndNum ||
                        range.versionChapterNum === range.versionChapterEndNum) &&
                    range.versionVerseNum &&
                    (!range.versionVerseEndNum ||
                        range.versionVerseNum > 1 ||
                        range.versionVerseEndNum <
                            book.getChapterVerseCount(range.versionChapterNum))
                ) {
                    contextRanges.versionChapter.completeRange = {
                        bookOsisId: book.osisId,
                        versionChapterNum: range.versionChapterNum
                    };
                }
                if (
                    range.versionVerseNum &&
                    range.versionVerseNum > 1 &&
                    range.versionChapterEndNum &&
                    range.versionChapterEndNum > range.versionChapterNum
                ) {
                    contextRanges.versionChapter.completeStartingRange = {
                        bookOsisId: book.osisId,
                        versionChapterNum: range.versionChapterNum
                    };
                }
                if (
                    range.versionChapterEndNum &&
                    range.versionChapterEndNum !== range.versionChapterNum &&
                    range.versionVerseEndNum &&
                    range.versionVerseEndNum < book.getChapterVerseCount(range.versionChapterEndNum)
                ) {
                    contextRanges.versionChapter.completeEndingRange = {
                        bookOsisId: book.osisId,
                        versionChapterNum: range.versionChapterEndNum
                    };
                }
            }
            if (rangeNormalized.normalizedChapterNum) {
                if (rangeNormalized.normalizedChapterNum > 1)
                    contextRanges.normalizedChapter.previousRange = {
                        bookOsisId: book.osisId,
                        normalizedChapterNum: rangeNormalized.normalizedChapterNum - 1
                    };
                if (
                    (rangeNormalized.normalizedChapterEndNum &&
                        rangeNormalized.normalizedChapterEndNum <
                            getNormalizedChapterCountForOsisId(book.osisId)) ||
                    (!rangeNormalized.normalizedChapterEndNum &&
                        rangeNormalized.normalizedChapterNum &&
                        rangeNormalized.normalizedChapterNum <
                            getNormalizedChapterCountForOsisId(book.osisId))
                ) {
                    contextRanges.normalizedChapter.nextRange = {
                        bookOsisId: book.osisId,
                        normalizedChapterNum: rangeNormalized.normalizedChapterEndNum
                            ? rangeNormalized.normalizedChapterEndNum + 1
                            : rangeNormalized.normalizedChapterNum! + 1
                    };
                }
                if (
                    (!rangeNormalized.normalizedChapterEndNum ||
                        rangeNormalized.normalizedChapterNum ===
                            rangeNormalized.normalizedChapterEndNum) &&
                    rangeNormalized.normalizedVerseNum &&
                    (!rangeNormalized.normalizedVerseEndNum ||
                        rangeNormalized.normalizedVerseNum > 1 ||
                        rangeNormalized.normalizedVerseEndNum <
                            getNormalizedVerseCount(
                                book.osisId,
                                rangeNormalized.normalizedChapterNum
                            ))
                ) {
                    contextRanges.normalizedChapter.completeRange = {
                        bookOsisId: book.osisId,
                        normalizedChapterNum: rangeNormalized.normalizedChapterNum
                    };
                }
                if (
                    rangeNormalized.normalizedVerseNum &&
                    rangeNormalized.normalizedVerseNum > 1 &&
                    rangeNormalized.normalizedChapterEndNum &&
                    rangeNormalized.normalizedChapterEndNum > rangeNormalized.normalizedChapterNum
                ) {
                    contextRanges.normalizedChapter.completeStartingRange = {
                        bookOsisId: book.osisId,
                        normalizedChapterNum: rangeNormalized.normalizedChapterNum
                    };
                }
                if (
                    rangeNormalized.normalizedChapterEndNum &&
                    rangeNormalized.normalizedChapterEndNum !==
                        rangeNormalized.normalizedChapterNum &&
                    rangeNormalized.normalizedVerseEndNum &&
                    rangeNormalized.normalizedVerseEndNum <
                        getNormalizedVerseCount(
                            book.osisId,
                            rangeNormalized.normalizedChapterEndNum
                        )
                ) {
                    contextRanges.normalizedChapter.completeEndingRange = {
                        bookOsisId: book.osisId,
                        normalizedChapterNum: rangeNormalized.normalizedChapterEndNum
                    };
                }
            }

            for (const sectionLevel of Object.keys(context).map(_sectionLevel => +_sectionLevel)) {
                if (context[sectionLevel] && context[sectionLevel].wrappingSection) {
                    contextRanges.sections[
                        sectionLevel
                    ].completeRange = generateRangeFromGenericSection(
                        context[sectionLevel].wrappingSection!
                    );
                } else if (context[sectionLevel].includedSections.length > 0) {
                    // => if there is a wrapping section, there can't be includedSections on the
                    //    same level
                    if (context[sectionLevel].includedSections[0].phraseStartId < firstPhraseId) {
                        contextRanges.sections[
                            sectionLevel
                        ].completeStartingRange = generateRangeFromGenericSection(
                            context[sectionLevel].includedSections[0]
                        );
                    }
                    if (
                        context[sectionLevel].includedSections[
                            context[sectionLevel].includedSections.length - 1
                        ].phraseEndId > lastPhraseId
                    ) {
                        contextRanges.sections[
                            sectionLevel
                        ].completeEndingRange = generateRangeFromGenericSection(
                            context[sectionLevel].includedSections[
                                context[sectionLevel].includedSections.length - 1
                            ]
                        );
                    }
                }

                if (context[sectionLevel] && context[sectionLevel].previousSections.length)
                    contextRanges.sections[
                        sectionLevel
                    ].previousRange = generateRangeFromGenericSection(
                        context[sectionLevel].previousSections[
                            context[sectionLevel].previousSections.length - 1
                        ]
                    );
                if (context[sectionLevel] && context[sectionLevel].nextSections.length)
                    contextRanges.sections[
                        sectionLevel
                    ].nextRange = generateRangeFromGenericSection(
                        context[sectionLevel].nextSections[0]
                    );
            }
        }

        const bibleDocument = generateBibleDocument(
            phrases,
            paragraphs,
            context,
            bookAbbreviations,
            version.chapterVerseSeparator
        );

        // when we are transmitting the data we want the returned object to be as slim as possible.
        // also: when we transmit to a client, local ids have to be stripped (versionId, sectionId)
        if (stripUnnecessaryData) {
            bibleDocument.contents = stripUnnecessaryDataFromBibleContent(bibleDocument.contents);

            delete version.id;
            delete version.copyrightLongJson;
            delete version.descriptionJson;
            if (!version.copyrightLong) delete version.copyrightLong;
            if (!version.description) delete version.description;
            if (!version.copyrightShort) delete version.copyrightShort;
            if (!version.hasStrongs) delete version.hasStrongs;

            delete book.versionId;
            delete book.chaptersMetaJson;
            delete book.introductionJson;
            if (!book.introduction) delete book.introduction;

            delete rangeNormalized.versionId;
            delete rangeNormalized.isNormalized;

            for (const rangeContext of <('paragraph' | 'versionChapter' | 'normalizedChapter')[]>[
                'paragraph',
                'versionChapter',
                'normalizedChapter'
            ]) {
                for (const rangeType of <(keyof IBibleOutputRich['contextRanges']['paragraph'])[]>(
                    Object.keys(contextRanges[rangeContext])
                )) {
                    contextRanges[rangeContext][rangeType] = slimDownReferenceRange(
                        contextRanges[rangeContext][rangeType]!
                    );
                }
            }

            for (const level of Object.keys(context).map(_level => +_level)) {
                for (const rangeType of <
                    (keyof IBibleOutputRich['contextRanges']['sections'][0])[]
                >Object.keys(contextRanges['sections'][level])) {
                    contextRanges['sections'][level][rangeType] = slimDownReferenceRange(
                        contextRanges['sections'][level][rangeType]!
                    );
                }

                // local helper
                const slimDownBibleSection = (section: IBibleSection): IBibleSection => {
                    const slimSection: IBibleSection = {
                        phraseStartId: section.phraseStartId,
                        phraseEndId: section.phraseEndId
                    };
                    if (section.title) slimSection.title = section.title;
                    if (section.subTitle) slimSection.subTitle = section.subTitle;
                    if (section.description) slimSection.description = section.description;
                    if (section.crossReferences)
                        slimSection.crossReferences = section.crossReferences.map(
                            slimDownCrossReference
                        );
                    return slimSection;
                };
                if (context[level].wrappingSection)
                    context[level].wrappingSection = slimDownBibleSection(
                        context[level].wrappingSection!
                    );
                context[level].includedSections = context[level].includedSections.map(
                    slimDownBibleSection
                );
                context[level].nextSections = context[level].nextSections.map(slimDownBibleSection);
                context[level].previousSections = context[level].previousSections.map(
                    slimDownBibleSection
                );
            }
        }

        return {
            version,
            versionBook: book,
            range: rangeNormalized,
            content: bibleDocument,
            context,
            contextRanges
        };
    }

    async getNextPhraseNumForNormalizedVerseNum(
        reference: IBibleReferenceNormalized
    ): Promise<number> {
        const entityManager = await this.pEntityManager;
        const lastPhrase = await entityManager.find(BiblePhrase, {
            where: { id: Raw(col => generatePhraseIdSql(reference, col)) },
            order: { id: 'DESC' },
            take: 1,
            select: ['id']
        });
        return lastPhrase.length ? parsePhraseId(lastPhrase[0].id).phraseNum! + 1 : 1;
    }

    async getPhrases(range: IBibleReferenceRangeNormalized | IBibleReferenceRangeVersion) {
        const entityManager = await this.pEntityManager;
        const normalizedRange =
            range.isNormalized === true
                ? <IBibleReferenceRangeNormalized>range
                : await this.getNormalizedReferenceRange(range);
        return entityManager.find(BiblePhrase, {
            where: { id: Raw(col => generatePhraseIdSql(normalizedRange, col)) },
            order: { id: 'ASC' },
            relations: ['notes', 'crossReferences']
        });
    }

    async getRawVersionData(versionId: number) {
        const entityManager = await this.pEntityManager;
        const version: IBibleVersion = await entityManager
            .findOne(BibleVersion, versionId)
            .then(generateMinimizedDbObject);
        const books: IBibleBook[] = await entityManager
            .find(BibleBook, { where: { versionId }, order: { number: 'ASC' } })
            .then(generateMinimizedDbObjects);
        const bookData: { book: IBibleBook; content: IBibleContent[] }[] = [];
        for (const book of books) {
            bookData.push({
                book,
                content: await this.getFullDataForReferenceRange({
                    version: version.version,
                    bookOsisId: book.osisId
                }).then(fullData => stripUnnecessaryDataFromBibleContent(fullData.content.contents))
            });
        }
        // const phrases = await entityManager
        //     .find(BiblePhrase, {
        //         where: { id: Raw(col => generatePhraseIdVersionSql(versionId, col)) },
        //         order: { id: 'ASC' }
        //     })
        //     .then(getMinimizedDbObjects)
        //     .then(_phrases =>
        //         _phrases.map(phrase => {
        //             // data is encoded in phrase.id
        //             delete phrase.reference;
        //             // strongsJoined takes less space
        //             delete phrase.strongs;
        //             return phrase;
        //         })
        //     );
        return { version, bookData };
        // deflate(
        //     JSON.stringify({
        //         version,
        //         books
        //     }),
        //     { to: 'string' }
        // );
    }

    async getReferenceRangeWithAllVersionProperties(
        range: IBibleReferenceRange,
        versionBook?: BibleBook
    ): Promise<IBibleReferenceRange> {
        if (!versionBook) {
            const entityManager = await this.pEntityManager;
            versionBook = await entityManager.findOne(BibleBook, {
                where: { versionId: range.versionId, osisId: range.bookOsisId }
            });
        }
        if (!versionBook) {
            throw new Error(
                `can't get normalized reference: invalid or missing version or book data`
            );
        }

        // setting all missing properties on reference
        const versionChapterEndNum =
            range.versionChapterEndNum ||
            range.versionChapterNum ||
            versionBook.chaptersCount.length;
        const versionVerseEndNum = range.versionVerseEndNum
            ? range.versionVerseEndNum
            : range.versionVerseNum &&
              (!range.versionChapterEndNum ||
                  range.versionChapterEndNum === range.versionChapterNum)
            ? range.versionVerseNum
            : versionBook.getChapterVerseCount(versionChapterEndNum);
        return {
            versionId: range.versionId,
            bookOsisId: range.bookOsisId,
            versionChapterNum: range.versionChapterNum || 1,
            versionChapterEndNum,
            versionVerseNum: range.versionVerseNum || 1,
            versionVerseEndNum
        };
    }

    async setVersion(version: string) {
        const entityManager = await this.pEntityManager;

        const versionDb = await entityManager.findOne(BibleVersion, { version });
        this.currentVersion = versionDb;
    }

    private async addBibleContent(
        contents: IBibleContentForInput[],
        state: {
            book: IBibleBook;
            context: BibleBookPlaintext;
            modifierState: PhraseModifiers;
            columnModifierState: { quoteWho?: string; person?: string };
            phraseStack: BiblePhrase[];
            paragraphStack: BibleParagraph[];
            sectionStack: BibleSection[];
            currentNormalizedChapter: number;
            currentNormalizedVerse: number;
            currentPhraseNum: number;
            sectionLevel: number;
            recursionLevel: number;
        }
    ): Promise<{ firstPhraseId: number | undefined; lastPhraseId: number | undefined }> {
        const entityManager = await this.pEntityManager;
        let firstPhraseId: number | undefined, lastPhraseId: number | undefined;
        for (const content of contents) {
            if (content.type === 'phrase') {
                const nRef = await this.getNormalizedReferenceFromV11nRules(
                    {
                        versionId: state.book.versionId,
                        bookOsisId: state.book.osisId,
                        versionChapterNum: content.versionChapterNum,
                        versionVerseNum: content.versionVerseNum
                    },
                    state.context
                );
                if (!nRef.normalizedChapterNum || !nRef.normalizedVerseNum)
                    throw new Error(`can't add phrases: normalisation failed`);

                if (
                    nRef.normalizedChapterNum === state.currentNormalizedChapter &&
                    nRef.normalizedVerseNum === state.currentNormalizedVerse
                ) {
                    state.currentPhraseNum++;
                } else {
                    // chapter switch?
                    // if (
                    //     nRef.normalizedChapterNum !== state.currentNormalizedChapter &&
                    //     state.phraseStack.length
                    // ) {
                    //     // we save the stack for each chapter (otherwise it might become too big)
                    //     // RADAR: test if we have to save more often (low-mem devices?)
                    //     entityManager.save(state.phraseStack);
                    //     state.phraseStack = [];
                    // }

                    state.currentPhraseNum = 1;
                    state.currentNormalizedChapter = nRef.normalizedChapterNum;
                    state.currentNormalizedVerse = nRef.normalizedVerseNum;

                    /*
                     * RADAR: we disable the following block since we actually don't want content
                     *        from the same verse in the same version be saved in two instances.
                     *        Let's rather have a db-uniqe error then to know something went bad.
                     *        For now, we leave the code for reference.

                    // since we have a verse switch we check if there are already phrases for this
                    // verse and version in the database and fetch the next phraseNum accordingly
                    state.currentPhraseNum = await this.getNextPhraseNumForNormalizedVerseNum(nRef);
                    */
                }

                // we are using a phraseStack to improve performance when adding to the database
                const phraseRef: Required<IBiblePhraseRef> = {
                    isNormalized: true,
                    bookOsisId: state.book.osisId,
                    normalizedChapterNum: nRef.normalizedChapterNum,
                    normalizedVerseNum: nRef.normalizedVerseNum,
                    versionId: state.book.versionId,
                    phraseNum: state.currentPhraseNum
                };
                const phraseId = generatePhraseId(phraseRef);
                if (!firstPhraseId) firstPhraseId = phraseId;
                lastPhraseId = phraseId;

                if (state.columnModifierState.quoteWho)
                    content.quoteWho = state.columnModifierState.quoteWho;
                if (state.columnModifierState.person)
                    content.person = state.columnModifierState.person;

                state.phraseStack.push(new BiblePhrase(content, phraseRef, state.modifierState));
            } else if (content.type === 'group' && content.groupType !== 'paragraph') {
                const backupModifierState = { ...state.modifierState };
                const backupColumnModifierState = { ...state.columnModifierState };

                if (content.groupType === 'quote') {
                    if (!state.modifierState.quoteLevel) state.modifierState.quoteLevel = 0;
                    state.modifierState.quoteLevel++;
                    state.columnModifierState.quoteWho = content.modifier;
                } else if (content.groupType === 'indent') {
                    if (!state.modifierState.indentLevel) state.modifierState.indentLevel = 0;
                    state.modifierState.indentLevel++;
                } else if (content.groupType === 'bold') state.modifierState.bold = true;
                else if (content.groupType === 'divineName') state.modifierState.divineName = true;
                else if (content.groupType === 'emphasis') state.modifierState.emphasis = true;
                else if (content.groupType === 'italic') state.modifierState.italic = true;
                else if (content.groupType === 'translationChange')
                    state.modifierState.translationChange = content.modifier;
                else if (content.groupType === 'person')
                    state.columnModifierState.person = content.modifier;
                else if (content.groupType === 'orderedListItem')
                    state.modifierState.orderedListItem = content.modifier;
                else if (content.groupType === 'unorderedListItem')
                    state.modifierState.orderedListItem = content.modifier;
                state.recursionLevel++;
                const {
                    firstPhraseId: groupFirstPhraseId,
                    lastPhraseId: groupLastPhraseId
                } = await this.addBibleContent(content.contents, state);
                state.recursionLevel--;
                if (groupFirstPhraseId && !firstPhraseId) firstPhraseId = groupFirstPhraseId;
                if (groupLastPhraseId) lastPhraseId = groupLastPhraseId;

                state.modifierState = backupModifierState;
                state.columnModifierState = backupColumnModifierState;
            } else if (
                (content.type === 'group' && content.groupType === 'paragraph') ||
                content.type === 'section'
            ) {
                if (content.type === 'section') state.sectionLevel++;

                state.recursionLevel++;
                let {
                    firstPhraseId: sectionFirstPhraseId,
                    lastPhraseId: sectionLastPhraseId
                } = await this.addBibleContent(content.contents, state);
                state.recursionLevel--;

                if (sectionFirstPhraseId && sectionLastPhraseId) {
                    if (content.type === 'group' && content.groupType === 'paragraph') {
                        state.paragraphStack.push(
                            new BibleParagraph(
                                state.book.versionId,
                                sectionFirstPhraseId,
                                sectionLastPhraseId
                            )
                        );
                    } else if (content.type === 'section') {
                        state.sectionStack.push(
                            new BibleSection({
                                versionId: state.book.versionId,
                                phraseStartId: sectionFirstPhraseId,
                                phraseEndId: sectionLastPhraseId,
                                level: state.sectionLevel,
                                title: content.title,
                                crossReferences: content.crossReferences,
                                description: content.description
                            })
                        );
                    }

                    if (!firstPhraseId) firstPhraseId = sectionFirstPhraseId;
                    lastPhraseId = sectionLastPhraseId;
                }

                if (content.type === 'section') state.sectionLevel--;
            }
        }

        if (state.recursionLevel === 0) {
            // we are at the end of the root method => persist everything
            await entityManager.save(state.phraseStack, { chunk: state.phraseStack.length / 500 });
            await entityManager.save(state.paragraphStack);
            await entityManager.save(state.sectionStack);
        }

        return { firstPhraseId, lastPhraseId };
    }

    private async addBook(book: IBibleBook) {
        const entityManager = await this.pEntityManager;
        return await entityManager.save(new BibleBook(book));
    }

    private async getBookForVersionReference({ versionId, bookOsisId }: IBibleReferenceVersion) {
        const entityManager = await this.pEntityManager;
        const where = { osisId: bookOsisId, versionId };

        return entityManager.findOne(BibleBook, { where });
    }

    // we excpect this to be an async method in the future
    // - to not break code then we make it async already
    private async getNormalizedReference(
        reference: IBibleReferenceVersion
    ): Promise<IBibleReferenceNormalized> {
        if (isReferenceNormalized(reference)) return { ...reference, isNormalized: true };
        // if reference has not data that can cause normalisation changes, return the reference
        // (-range) right away
        if (
            !reference.versionId ||
            !reference.versionChapterNum ||
            !reference.versionVerseNum // RADAR: is it safe to return here if no versionVerse?
        )
            return generateNormalizedReferenceFromVersionReference(reference);

        // RADAR: test if it is really faster to check for the existence of v11n rules for this
        // reference before looking into the phrases table
        const normalisationRules = await this.getNormalisationRulesForReference(reference);

        // there are no rules for this reference(-range) than can cause normalisation changes
        if (!normalisationRules.length)
            return generateNormalizedReferenceFromVersionReference(reference);

        // see if we already have the reference in the database
        const referenceContextRange = generateContextRangeFromVersionRange(reference);
        const entityManager = await this.pEntityManager;
        const refPhrase = await entityManager.findOne(BiblePhrase, {
            where: {
                id: Raw(col =>
                    generatePhraseIdSql(
                        {
                            isNormalized: true,
                            bookOsisId: reference.bookOsisId,
                            normalizedChapterNum: referenceContextRange.versionChapterNum,
                            normalizedVerseNum: referenceContextRange.versionVerseNum,
                            normalizedChapterEndNum: referenceContextRange.versionChapterEndNum,
                            normalizedVerseEndNum: referenceContextRange.versionVerseEndNum,
                            versionId: reference.versionId
                        },
                        col
                    )
                ),
                versionChapterNum: reference.versionChapterNum,
                versionVerseNum: reference.versionVerseNum
            }
        });

        if (!refPhrase) throw new Error(`can't get normalized reference: version data not in DB`);

        return {
            ...reference,
            isNormalized: true,
            normalizedChapterNum: refPhrase.normalizedReference.normalizedChapterNum,
            normalizedVerseNum: refPhrase.normalizedReference.normalizedVerseNum
        };
    }

    private async getNormalizedReferenceFromV11nRules(
        reference: IBibleReferenceVersion,
        context: BibleBookPlaintext
    ): Promise<IBibleReferenceNormalized> {
        if (isReferenceNormalized(reference)) return { ...reference, isNormalized: true };

        // if reference has not data that can cause normalisation changes or if normalisation data
        // already there, return the reference(-range) right away
        if (
            !reference.versionId ||
            !reference.versionChapterNum ||
            !reference.versionVerseNum // RADAR: is it safe to return here if no versionVerse?
        )
            return generateNormalizedReferenceFromVersionReference(reference);

        const normalisationRules = await this.getNormalisationRulesForReference(reference);

        // there are no rules for this reference(-range) than can cause normalisation changes
        if (!normalisationRules.length)
            return generateNormalizedReferenceFromVersionReference(reference);

        for (const rule of normalisationRules) {
            this.runV11nRuleOnReference(reference, rule, context);
        }

        // TODO: normalize this using the v11n-normalisation data from STEPData
        return generateNormalizedReferenceFromVersionReference(reference);
    }

    private async getNormalizedReferenceRange(
        range: IBibleReferenceRangeVersion
    ): Promise<IBibleReferenceRangeNormalized> {
        if (isReferenceNormalized(range)) return { ...range, isNormalized: true };
        const { normalizedChapterNum, normalizedVerseNum } = await this.getNormalizedReference(
            range
        );
        const normRange: IBibleReferenceRangeNormalized = {
            ...range,
            isNormalized: true,
            normalizedChapterNum,
            normalizedVerseNum
        };
        if (range.versionChapterEndNum || range.versionVerseEndNum) {
            const {
                normalizedChapterNum: normalizedChapterEndNum,
                normalizedVerseNum: normalizedVerseEndNum
            } = await this.getNormalizedReference({
                versionId: range.versionId,
                bookOsisId: range.bookOsisId,
                versionChapterNum: range.versionChapterEndNum || range.versionChapterNum,
                versionVerseNum: range.versionVerseEndNum
            });
            normRange.normalizedChapterEndNum = normalizedChapterEndNum;
            normRange.normalizedVerseEndNum = normalizedVerseEndNum;
        }

        return normRange;
    }

    // this is probably async when implemented
    private async getNormalisationRulesForReference(_: IBibleReferenceRangeVersion) {
        // TODO: implement
        return [];
    }

    private async normalizeCrossReferencesForVersion(versionId: number) {
        const entityManager = await this.pEntityManager;
        // go through each bible book seperately
        for (const book of await entityManager.find(BibleBook)) {
            // fetch all cross reference for that version and book
            for (const cRef of await entityManager.find(BibleCrossReference, {
                where: {
                    versionId,
                    normalizedRefId: Raw(col =>
                        generateReferenceIdSql({ isNormalized: true, bookOsisId: book.osisId }, col)
                    )
                }
            })) {
                // get normalized reference range
                // we know that this crossRef has a versionId since we queried for it
                const normalizedRange = await this.getNormalizedReferenceRange(<
                    IBibleReferenceRangeVersion
                >cRef.range);
                if (cRef.versionChapterNum)
                    cRef.range.normalizedChapterNum = normalizedRange.normalizedChapterNum;
                if (cRef.versionVerseNum)
                    cRef.range.normalizedVerseNum = normalizedRange.normalizedVerseNum;
                if (cRef.versionChapterEndNum)
                    cRef.range.normalizedChapterEndNum = normalizedRange.normalizedChapterEndNum;
                if (cRef.versionVerseEndNum)
                    cRef.range.normalizedVerseEndNum = normalizedRange.normalizedVerseEndNum;
                // and save cross reference back to db
                entityManager.save(cRef);
            }
        }
    }

    private runV11nRuleOnReference(
        reference: IBibleReference,
        rule: any,
        context: BibleBookPlaintext
    ) {
        // TODO: implement
        return !rule || !context ? reference : reference;
    }
}
