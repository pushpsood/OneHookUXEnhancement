import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';
import type { TokenCredential } from '@azure/identity';
import { toFile, type AzureOpenAI } from 'openai';
import type { DocumentReader, Transcriber, VisionReader } from './attachmentProcessor';

/**
 * The Azure AI services that read attachments, all with the App Service's managed identity (no keys):
 *  - vision: the Azure OpenAI chat deployment (gpt-4o) with image input;
 *  - transcription: an Azure OpenAI speech-to-text deployment (e.g. `gpt-transcribe`);
 *  - documents: Azure AI Document Intelligence `prebuilt-read` (PDF, DOCX, XLSX, PPTX, HEIC).
 */
export class AzureVisionReader implements VisionReader {
  constructor(private readonly client: AzureOpenAI, private readonly deployment: string) {}

  async describe(images: Array<{ mediaType: string; bytes: Uint8Array }>, instruction: string) {
    const completion = await this.client.chat.completions.create({
      model: this.deployment,
      max_tokens: 1_200,
      messages: [
        { role: 'system', content: 'You extract the content of files for Mr OneHook, a chat assistant. Be complete and factual.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            ...images.map((image) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`, detail: 'high' as const },
            })),
          ],
        },
      ],
    });
    return {
      text: completion.choices[0]?.message?.content ?? '',
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    };
  }
}

export class AzureTranscriber implements Transcriber {
  constructor(private readonly client: AzureOpenAI, private readonly deployment: string) {}

  async transcribe(bytes: Uint8Array, fileName: string, mediaType: string) {
    const result = await this.client.audio.transcriptions.create({
      model: this.deployment,
      file: await toFile(Buffer.from(bytes), fileName, { type: mediaType }),
      response_format: 'json',
    });
    // Newer transcription models report the billed duration in `usage`.
    const usage = (result as { usage?: { type?: string; seconds?: number } }).usage;
    return {
      text: result.text ?? '',
      ...(usage?.type === 'duration' && typeof usage.seconds === 'number' ? { seconds: usage.seconds } : {}),
    };
  }
}

export class AzureDocumentReader implements DocumentReader {
  private readonly client: ReturnType<typeof DocumentIntelligence>;

  constructor(endpoint: string, credential: TokenCredential) {
    this.client = DocumentIntelligence(endpoint, credential);
  }

  async read(bytes: Uint8Array, maxPages: number) {
    const initial = await this.client.path('/documentModels/{modelId}:analyze', 'prebuilt-read').post({
      contentType: 'application/json',
      body: { base64Source: Buffer.from(bytes).toString('base64') },
      queryParameters: { pages: `1-${maxPages}` },
    });
    if (isUnexpected(initial)) {
      throw Object.assign(new Error(`Document Intelligence: ${initial.body.error?.code ?? 'error'}`), { status: Number(initial.status) });
    }
    const poller = getLongRunningPoller(this.client, initial);
    const done = await poller.pollUntilDone();
    const body = done.body as { status?: string; analyzeResult?: { content?: string; pages?: unknown[] } };
    if (body.status !== 'succeeded' || !body.analyzeResult) {
      throw Object.assign(new Error('Document Intelligence analysis failed'), { status: 422 });
    }
    return { text: body.analyzeResult.content ?? '', pages: body.analyzeResult.pages?.length ?? 1 };
  }
}
