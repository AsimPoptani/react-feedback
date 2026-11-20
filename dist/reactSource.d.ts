export interface SourceLocation {
    file: string;
    line: number;
    column: number;
    component: string;
    runtime?: true;
    ancestor?: true;
}
export interface ReactSource {
    source?: SourceLocation;
    components: string[];
}
export declare const MAX_COMPONENTS = 40;
export declare function reactSource(element: Element): ReactSource;
