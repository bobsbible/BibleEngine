export interface IBibleReferenceNormalizedNumbers {
    normalizedChapterNum?: number;
    normalizedVerseNum?: number;
}

export interface IBibleReferenceBase extends IBibleReferenceNormalizedNumbers {
    bookOsisId: string;
    versionId?: number;
}

export interface IBiblePhraseRef extends IBibleReferenceBase {
    phraseNum?: number;
    isNormalized: true;
}

export interface IBibleReference extends IBibleReferenceBase {
    /**
     * we need this property to enable checking for normalization on the TypeScript level, i.e. not
     * only during runtime. During runtime we check for normalization via isReferenceNormalized() -
     * this allows us work with objects that have the property not set (e.g. because it was stripped
     * to save space for transmission) and re-set the flag
     */
    isNormalized?: boolean;
    versionChapterNum?: number;
    versionVerseNum?: number;
}

export interface IBibleReferenceRange extends IBibleReference {
    normalizedChapterEndNum?: number;
    normalizedVerseEndNum?: number;
    versionChapterEndNum?: number;
    versionVerseEndNum?: number;
}

export interface IBibleReferenceNormalized extends IBibleReference {
    isNormalized: true;
}

export interface IBibleReferenceVersion extends IBibleReference {
    versionId: number;
}

export interface IBibleReferenceVersionNormalized extends IBibleReferenceVersion {
    isNormalized: true;
}

export interface IBibleReferenceRangeNormalized extends IBibleReferenceRange {
    isNormalized: true;
}

export interface IBibleReferenceRangeVersion extends IBibleReferenceRange {
    versionId: number;
}

export interface IBibleReferenceRangeVersionNormalized extends IBibleReferenceRangeVersion {
    isNormalized: true;
}

export interface IBibleReferenceRangeQuery extends IBibleReferenceRange {
    /** we don't allow versionId in a query since it local and remote ids are not the same */
    versionId?: undefined;
    version: string;
}
