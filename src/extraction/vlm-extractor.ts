// ============================================================
// VLM extraction — render page to image and send to vision LLM
// ============================================================

export interface VLMPageInput {
  pageNumber: number;
  imageBase64: string; // data:image/png;base64,...
}

/**
 * Build vision message for a single page.
 */
export function buildVisionMessage(page: VLMPageInput, userPrompt: string) {
  return {
    role: 'user' as const,
    content: [
      { type: 'text', text: userPrompt },
      {
        type: 'image_url',
        image_url: { url: page.imageBase64 },
      },
    ],
  };
}

/**
 * Build vision messages for multiple pages.
 * Groups pages into batches of 2 to reduce token usage.
 */
export function buildVisionMessagesBatch(
  pages: VLMPageInput[],
  userPromptTemplate: (pageNumber: number) => string,
): Array<{ role: 'user'; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> {
  const messages: Array<{ role: 'user'; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];

  for (let i = 0; i < pages.length; i += 2) {
    const batch = pages.slice(i, i + 2);
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    for (const page of batch) {
      content.push({
        type: 'text',
        text: userPromptTemplate(page.pageNumber),
      });
      content.push({
        type: 'image_url',
        image_url: { url: page.imageBase64 },
      });
    }

    messages.push({ role: 'user', content });
  }

  return messages;
}
