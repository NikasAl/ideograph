declare module 'djvujs-dist/library/src/index.js' {
  export interface DjVuPage {
    getText(): string;
    getImageData(rotate?: boolean): ImageData;
    getWidth(): number;
    getHeight(): number;
    getDpi(): number;
    getRotation(): number;
    init(): DjVuPage;
    decode(): DjVuPage;
    getDependencies(): string[];
  }

  export interface DjVuDocument {
    getPagesQuantity(): number;
    getContents(): Array<{ description: string; url: string; children?: Array<{ description: string; url: string; children?: unknown[] }> }> | null;
    getPage(number: number): Promise<DjVuPage>;
    getPageUnsafe(number: number): DjVuPage | undefined;
    getPagesSizes(): Array<{ width: number; height: number; dpi: number }>;
    isBundled(): boolean;
  }

  const DjVu: {
    VERSION: string;
    IS_DEBUG: boolean;
    setDebugMode(flag: boolean): void;
    Document: new (arraybuffer: ArrayBuffer, options?: { baseUrl?: string; memoryLimit?: number }) => DjVuDocument;
    Worker: unknown;
    ErrorCodes: unknown;
  };

  export default DjVu;
}
