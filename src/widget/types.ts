export interface Rect { x: number; y: number; width: number; height: number }
export type CaptureMode = 'region' | 'element' | 'section' | 'page';
export interface ElementTarget {
  selector: string; tag: string; role: string; name: string;
  text: string; rect: Rect; components: string[];
}
export type Target = ElementTarget | { rect: Rect } | { width: number; height: number };
export interface FeedbackItem {
  id: string; created_at: string; url: string; mode: CaptureMode; note_first_line: string;
  status: 'new' | 'seen' | 'done'; reply: string | null;
}
export interface Shot { url: string; width: number; height: number; origin: { x: number; y: number } }
export interface Capture {
  shot: Shot; contextImage?: string; clipped?: string;
}
