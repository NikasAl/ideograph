// ============================================================
// File Access Utilities — File System Access API wrapper
// ============================================================

export interface FilePickerOptions {
  accept?: Array<{ description: string; extensions: string[] }>;
  multiple?: boolean;
}

const DEFAULT_ACCEPT = [
  { description: 'Книги (PDF, DJVU)', extensions: ['.pdf', '.djvu', '.djv'] },
];

export async function pickFiles(options?: FilePickerOptions): Promise<FileSystemFileHandle[]> {
  const types = (options?.accept || DEFAULT_ACCEPT).map((item) => ({
    description: item.description,
    accept: {
      'application/pdf': item.extensions.filter((e) => e === '.pdf'),
      'image/vnd.djvu': item.extensions.filter((e) => ['.djvu', '.djv'].includes(e)),
    },
  }));

  return (window as unknown as { showOpenFilePicker: (opts?: unknown) => Promise<FileSystemFileHandle[]> })
    .showOpenFilePicker({ types, multiple: options?.multiple ?? false });
}

export async function readFileAsBuffer(handle: FileSystemFileHandle): Promise<ArrayBuffer> {
  const file = await handle.getFile();
  return file.arrayBuffer();
}

export async function getFileMeta(handle: FileSystemFileHandle): Promise<{ name: string; size: number; type: string }> {
  const file = await handle.getFile();
  return { name: file.name, size: file.size, type: file.type };
}
