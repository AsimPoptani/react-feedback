export interface Shot {
  nonce: string;
  note: string; mode: 'region' | 'element' | 'section' | 'page'; image: string | null;
  rect: { x: number; y: number; width: number; height: number } | null; viewport: { width: number; height: number } | null; box: [number, number, number, number] | null;
  selector: string; text: string; components: string[]; source: { file: string; line: number; column: number; component: string } | null;
}
export function parseShot(data: unknown, maxImageChars: number): Shot | null;
