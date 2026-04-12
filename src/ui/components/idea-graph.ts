// ============================================================
// Idea Graph View — vis-network force-directed graph
// ============================================================

import { DataSet } from 'vis-data';
import { Network } from 'vis-network';
import { db } from '../../db/index.js';
import type { Idea } from '../../db/schema.js';
import '../styles/components/idea-graph.css';

const STAT_COLORS: Record<string, { bg: string; border: string }> = {
  unseen: { bg: '#6B7280', border: '#9CA3AF' },
  in_progress: { bg: '#D97706', border: '#FBBF24' },
  mastered: { bg: '#059669', border: '#34D399' },
  applied: { bg: '#2563EB', border: '#60A5FA' },
  confused: { bg: '#DC2626', border: '#F87171' },
  known: { bg: '#7C3AED', border: '#A78BFA' },
  heard: { bg: '#0891B2', border: '#22D3EE' },
  new: { bg: '#6B7280', border: '#FCD34D' },
  unknown: { bg: '#374151', border: '#6B7280' },
};

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

export class IdeaGraphView {
  private container: HTMLElement;
  private bookId: string;
  private network: Network | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  async render(): Promise<void> {
    const ideas = await db.ideas.where('bookId').equals(this.bookId).toArray();
    console.log(`[Graph] bookId=${this.bookId}, ideas found: ${ideas.length}`);

    this.container.innerHTML = `
      <div class="graph-view">
        <div class="view-header">
          <h2>~ Граф идей</h2>
          <span class="idea-count">${ideas.length} идей</span>
          <button class="secondary-btn" id="btn-graph-fit">Масштабировать</button>
        </div>
        <div class="graph-legend">
          <span class="legend-item"><span class="dot" style="background:#6B7280"></span> Не изучал</span>
          <span class="legend-item"><span class="dot" style="background:#D97706"></span> В процессе</span>
          <span class="legend-item"><span class="dot" style="background:#059669"></span> Освоено</span>
          <span class="legend-item"><span class="dot" style="background:#DC2626"></span> Не понятно</span>
          <span class="legend-item"><span class="dot" style="background:#7C3AED"></span> Знакомо</span>
        </div>
        <div class="graph-container" id="graph-wrapper">
          ${ideas.length === 0 ? `
            <div class="empty-state"><div class="empty-icon">~</div>
              <p>Граф пуст</p><p class="empty-hint">Сначала извлеките идеи</p></div>
          ` : '<div id="graph-canvas" class="graph-canvas"></div>'}
        </div>
      </div>`;

    if (ideas.length > 0) {
      // Wait for layout so the canvas has real dimensions
      requestAnimationFrame(() => {
        this.initGraph(ideas);
      });
    }
    this.bindEvents();
  }

  private initGraph(ideas: Idea[]): void {
    try {
      const canvas = document.getElementById('graph-canvas');
      if (!canvas) {
        console.error('[Graph] #graph-canvas element not found');
        return;
      }

      // Check canvas has real dimensions
      const rect = canvas.getBoundingClientRect();
      console.log(`[Graph] Canvas dimensions: ${rect.width}x${rect.height}`);
      if (rect.width === 0 || rect.height === 0) {
        console.error('[Graph] Canvas has zero dimensions, retrying after layout...');
        // Retry once after a longer delay
        setTimeout(() => {
          const retryRect = canvas.getBoundingClientRect();
          console.log(`[Graph] Retry dimensions: ${retryRect.width}x${retryRect.height}`);
          if (retryRect.width > 0 && retryRect.height > 0) {
            this.buildNetwork(canvas, ideas);
          } else {
            canvas.innerHTML = '<div class="empty-state"><p>Ошибка: контейнер графа не имеет размеров</p></div>';
          }
        }, 200);
        return;
      }

      this.buildNetwork(canvas, ideas);
    } catch (err) {
      console.error('[Graph] Init failed:', err);
      const canvas = document.getElementById('graph-canvas');
      if (canvas) {
        canvas.innerHTML = `<div class="empty-state"><p>Ошибка инициализации графа: ${(err as Error).message}</p></div>`;
      }
    }
  }

  private buildNetwork(canvas: HTMLElement, ideas: Idea[]): void {
    const nodes = new DataSet(ideas.map(idea => ({
      id: idea.id,
      label: idea.title,
      title: `${idea.summary}\n\nСтр.: ${idea.pages.join(', ')}\nТип: ${idea.type}`,
      shape: SHAPES[idea.type] || 'dot',
      color: {
        background: (STAT_COLORS[idea.status] || STAT_COLORS.unknown).bg,
        border: (STAT_COLORS[idea.status] || STAT_COLORS.unknown).border,
        highlight: { background: '#ffffff', border: '#ffffff' },
      },
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

    // Fit the view after stabilization completes
    this.network.once('stabilizationIterationsDone', () => {
      this.network?.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' as any } });
    });

    // Also fit after a timeout as fallback (in case stabilization event doesn't fire)
    setTimeout(() => {
      this.network?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' as any } });
    }, 3000);

    console.log(`[Graph] Network created: ${nodes.length} nodes, ${edges.length} edges`);
  }

  private bindEvents(): void {
    document.getElementById('btn-graph-fit')?.addEventListener('click', () => {
      this.network?.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' as any } });
    });
  }
}
