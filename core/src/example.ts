const wordGen = require('random-words');

import { BibleEngine } from './BibleEngine.class';
import { BibleVersion } from './entities';
import { getOsisIdFromBookGenericId } from './data/bibleMeta';
import { IBibleInputGroup, IBibleInputPhrase } from './models';

const sqlBible = new BibleEngine({
    type: 'sqlite',
    database: 'bible.db'
});

export const genDb = async () => {
    const esvVersion = await sqlBible.addVersion(
        new BibleVersion({
            version: 'ESV',
            title: 'English Standard Bible',
            language: 'en-US',
            chapterVerseSeparator: ':'
        })
    );
    for (let bookNum = 1; bookNum <= 2; bookNum++) {
        console.log(
            'adding book ' + bookNum
            // ' and chapter ' +
            // chapter +
            // ' and paragraph ' +
            // (paragraph + 1)
        );
        const paragraphs: IBibleInputGroup[] = [];
        for (let chapter = 1; chapter <= 15; chapter++) {
            for (let paragraph = 0; paragraph < 5; paragraph++) {
                let phrases = [];
                for (let verse = paragraph * 5 + 1; verse <= (paragraph + 1) * 5; verse++) {
                    for (let phraseIdx = 1; phraseIdx <= 22; phraseIdx++) {
                        const phrase: IBibleInputPhrase = {
                            type: 'phrase',
                            versionChapterNum: chapter,
                            versionVerseNum: verse,
                            content: wordGen({ min: 1, max: 2, join: ' ' }),
                            notes:
                                verse % 7 === 0 && phraseIdx === 1
                                    ? [
                                          {
                                              type: 'study',
                                              key: '1',
                                              content: [
                                                  {
                                                      type: 'phrase',
                                                      content: wordGen({
                                                          min: 1,
                                                          max: 30,
                                                          join: ' '
                                                      })
                                                  }
                                              ]
                                          }
                                      ]
                                    : undefined,
                            strongs: ['G' + phraseIdx * verse],
                            crossReferences:
                                verse % 5 === 0 && phraseIdx === 1
                                    ? [
                                          {
                                              key: 'a',
                                              range: {
                                                  bookOsisId: 'Exod',
                                                  versionChapterNum: 1,
                                                  versionVerseNum: 5,
                                                  versionVerseEndNum: 7
                                              }
                                          }
                                      ]
                                    : undefined
                        };
                        phrases.push(phrase);
                    }
                }
                paragraphs.push({ type: 'group', groupType: 'paragraph', contents: phrases });
            }
        }
        await sqlBible.addBookWithContent({
            book: {
                versionId: esvVersion.id,
                number: bookNum,
                osisId: getOsisIdFromBookGenericId(bookNum),
                abbreviation: wordGen({ min: 1, max: 1, join: ' ' }),
                title: wordGen({ min: 1, max: 3, join: ' ' }),
                type: bookNum < 40 ? 'ot' : 'nt'
            },
            contents: paragraphs
        });
    }

    sqlBible.finalizeVersion(esvVersion.id);
};

export const getData = async () => {
    const output = await sqlBible.getFullDataForReferenceRange({
        versionId: 1,
        bookOsisId: 'Gen',
        versionChapterNum: 1,
        versionVerseNum: 4,
        versionVerseEndNum: 6
    });
    console.dir(output, { depth: 8 });

    // const versionData = await sqlBible.getRawVersionData(1);
    // console.dir(versionData.bookData[0].content, { depth: 7 });

    // fs.writeFile(
    //     `${versionData.version.version}.beifz`,
    //     deflate(JSON.stringify(versionData), { to: 'string' }),
    //     (err: any) => console.log(err)
    // );

    // fs.writeFile(`${versionData.version.version}.beif`, JSON.stringify(versionData));
};

const run = async () => {
    // await genDb();
    getData();
};

run();
