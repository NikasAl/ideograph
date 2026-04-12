// ============================================================
// Idea Graph View — vis-network force-directed graph
// ============================================================

import { DataSet } from 'vis-data';
import { Network } from 'vis-network';
import { db } from '../../db/index.js';
import type { Idea, TOCEntry } from '../../db/schema.js';
import { assignChapterIds } from '../../extraction/toc-extractor.js';
import '../styles/components/idea-graph.css';

const SHAPES: Record<string, string> = {
  definition: 'dot', method: 'square', theorem: 'diamond',
  insight: 'triangle', example: 'dot', analogy: 'triangleDown',
};

const EDGE_STYLES: Record<string, { color: string; width: number }> = {
  prerequisite: { color: '#EF4444', width: 3 },
  elaborates: { color: '#3B82F6', width: 2 },
  contradicts: { color: '#F97316', width: 2 },
  analogous: { color: '#A78BFA', width: 1 },
  applies: { color: '#10B981', width: 2 },
};

/** Distinct pastel-ish colors for chapter groups */
const CHAPTER_PALETTE = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
  '#14B8A6', '#E11D48', '#A855F7', '#0EA5E9', '#D97706',
];

export class IdeaGraphView {
  private container: HTMLElement;
  private bookId: string;
  private network: Network | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const book = await db.books.get(this.bookId);
    const toc = book?.tableOfContents || [];
    const pageOffset = book?.pageOffset || 0;
    const ideas = await db.ideas.where('bookId').equals(this.bookId).toArray();

    // Re-compute chapterIds with current pageOffset
    assignChapterIds(ideas, toc, pageOffset);

    // Build chapter groups
    const chapters = toc.filter(e => e.level === 1 && e.pageEnd !== undefined);
    const chapterMap = new Map<string, TOCEntry>();
    for (const ch of chapters) chapterMap.set(ch.id, ch);

    const chapterIds = [...new Set(ideas.map(i => i.chapterId).filter(Boolean) as string[])];

    // Build groups for vis-network
    const groups: Record<string, { color: { background: string; border: string; highlight: { background: string; border: string } }; font: { color: string } }> = {};
    let noChapterCount = 0;

    for (let idx = 0; idx < chapterIds.length; idx++) {
      const chId = chapterIds[idx];
      const ch = chapterMap.get(chId);
      const color = CHAPTER_PALETTE[idx % CHAPTER_PALETTE.length];
      const label = ch ? (ch.title.length > 30 ? ch.title.substring(0, 28) + '...' : ch.title) : chId;
      groups[chId] = {
        color: {
          background: color,
          border: color,
          highlight: { background: '#ffffff', border: '#ffffff' },
        },
        font: { color: '#e0e0e0' },
      };
    }
    noChapterCount = ideas.filter(i => !i.chapterId).length;
    if (noChapterCount > 0) {
      groups['_none'] = {
        color: {
          background: '#4B5563',
          border: '#6B7280',
          highlight: { background: '#ffffff', border: '#ffffff' },
        },
        font: { color: '#e0e0e0' },
      };
    }

    // Build chapter legend HTML
    const chapterLegend = chapterIds.map((chId, idx) => {
      const ch = chapterMap.get(chId);
      const color = CHAPTER_PALETTE[idx % CHAPTER_PALETTE.length];
      const count = ideas.filter(i => i.chapterId === chId).length;
      const label = ch ? (ch.title.length > 25 ? ch.title.substring(0, 23) + '...' : ch.title) : '?';
      return `<span class="legend-item"><span class="dot" style="background:${color}"></span>${label} (${count})</span>`;
    }).join('');

    console.log(`[Graph] bookId=${this.bookId}, ideas: ${ideas.length}, chapters: ${chapterIds.length}`);

    this.container.innerHTML = `
      <div class="graph-view">
        <div class="graph-toolbar">
          <div class="graph-toolbar-left">
            <span class="graph-title">~ Граф идей</span>
            <span class="idea-count">${ideas.length} идей</span>
          </div>
          <div class="graph-toolbar-right">
            <button class="secondary-btn btn-sm" id="btn-graph-fit">Масштабировать</button>
          </div>
        </div>
        ${chapterIds.length > 0 || noChapterCount > 0 ? `
        <div class="graph-legend">
          ${chapterLegend}
          ${noChapterCount > 0 ? `<span class="legend-item"><span class="dot" style="background:#4B5563"></span>Без главы (${noChapterCount})</span>` : ''}
        </div>` : ''}
        <div class="graph-container" id="graph-wrapper">
          ${ideas.length === 0 ? `
            <div class="empty-state"><div class="empty-icon">~</div>
              <p>Граф пуст</p><p class="empty-hint">Сначала извлеките идеи</p></div>
          ` : '<div id="graph-canvas" class="graph-canvas"></div>'}
        </div>
      </div>`;

    if (ideas.length > 0) {
      requestAnimationFrame(() => {
        this.initGraph(ideas, groups);
      });
    }
    this.bindEvents();
  }

  private initGraph(ideas: Idea[], groups: Record<string, any>): void {
    try {
      const canvas = document.getElementById('graph-canvas');
      if (!canvas) {
        console.error('[Graph] #graph-canvas element not found');
        return;
      }

      const rect = canvas.getBoundingClientRect();
      console.log(`[Graph] Canvas dimensions: ${rect.width}x${rect.height}`);
      if (rect.width === 0 || rect.height === 0) {
        setTimeout(() => {
          const retryRect = canvas.getBoundingClientRect();
          if (retryRect.width > 0 && retryRect.height > 0) {
            this.buildNetwork(canvas, ideas, groups);
          }
        }, 200);
        return;
      }

      this.buildNetwork(canvas, ideas, groups);
    } catch (err) {
      console.error('[Graph] Init failed:', err);
    }
  }

  private buildNetwork(canvas: HTMLElement, ideas: Idea[], groups: Record<string, any>): void {
    const nodes = new DataSet(ideas.map(idea => ({
      id: idea.id,
      label: idea.title,
      title: `${idea.summary}\n\nСтр.: ${idea.pages.join(', ')}\nТип: ${idea.type}`,
      shape: SHAPES[idea.type] || 'dot',
      group: idea.chapterId || '_none',
      size: Math.max(15, idea.importance * 8),
      font: { size: 12, color: '#e0e0e0' },
      borderWidth: 2,
      borderWidthSelected: 4,
    })));

    const edges = new DataSet(ideas.flatMap(idea =>
      idea.relations.map(rel => {
        const es = EDGE_STYLES[rel.type] || { color: '#6B7280', width: 1 };
        return {
          id: `${idea.id}-${rel.targetId}`,
          from: idea.id,
          to: rel.targetId,
          arrows: rel.type === 'prerequisite' ? 'to' : undefined,
          color: { color: es.color, highlight: es.color },
          width: es.width,
          dashes: rel.type === 'analogous' ? [5, 5] : undefined,
          title: `${rel.type}${rel.description ? ': ' + rel.description : ''}`,
        };
      }),
    ));

    this.network = new Network(canvas as HTMLElement, { nodes, edges }, {
      groups,
      physics: {
        forceAtlas2Based: {
          gravitationalConstant: -80, centralGravity: 0.01,
          springLength: 150, springConstant: 0.08,
        },
        maxVelocity: 50, solver: 'forceAtlas2Based',
        stabilization: { iterations: 150 },
      },
      interaction: { hover: true, tooltipDelay: 200, zoomView: true, dragView: true },
      edges: { smooth: { type: 'continuous' as const, enabled: true, roundness: 0.5 } },
    });

    // Fit the view after stabilization
    this.network.once('stabilizationIterationsDone', () => {
      this.network?.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' as any } });
    });

    // Fallback fit
    setTimeout(() => {
      this.network?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' as any } });
    }, 3000);

    console.log(`[Graph] Network: ${nodes.length} nodes, ${edges.length} edges, ${Object.keys(groups).length} groups`);
  }

  private bindEvents(): void {
    document.getElementById('btn-graph-fit')?.addEventListener('click', () => {
      this.network?.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' as any } });
    });
  }
}
