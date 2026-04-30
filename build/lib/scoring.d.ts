import type { DiscourseTopic } from "../types.js";
export declare function scoreTopic(t: DiscourseTopic): number;
export declare function sortByRelevance<T extends DiscourseTopic>(topics: T[]): T[];
