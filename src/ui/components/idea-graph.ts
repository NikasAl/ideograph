// ============================================================
// Idea Graph View — D3 SVG mind-map with collapsible branches
//
// Tree structure: Book → Chapters → Sections → Ideas
// - Nodes are rounded rectangles with text INSIDE (mindmap style)
// - Chapters connected by sequential dashed arrows
// - Collapsible branches with count badges
// - Chapter spectrum: red → violet
// - Section colors: same hue, less saturated
// - Idea colors: by mastery status / familiarity
// - Cross-branch relation indicators
// ============================================================

import * as d3 from 'd3';
import { db } from '../../db/index.js';
import type { Idea, TOCEntry, Familiarity, IdeaStatus } from '../../db/schema.js';
import { assignChapterIds } from '../../extraction/toc-extractor.js';
import '../styles/components/idea-graph.css';

// ============================================================
// Types
// ============================================================

interface TreeNodeInfo {
  id: string;
  name: string;
  nodeType: 'root' | 'chapter' | 'section' | 'idea';
  tocEntry?: TOCEntry;
  idea?: Idea;
  chapterIndex?: number;
  chapterHue?: number;
  color?: string;
  ideaCount?: number;
  crossLinks?: number;
  children?: TreeNodeInfo[];
}

interface HNode extends d3.HierarchyPointNode<TreeNodeInfo> {
  x0: number;
  y0: number;
  _children?: HNode[];
}

interface Point {
  x: number;
  y: number;
}

// ============================================================
// Node Dimensions (mindmap rects)
// ============================================================

/** Approximate px per character for Cyrillic text */
const CHAR_WIDTH: Record<string, number> = {
  root: 7.8,
  chapter: 7.2,
  section: 6.6,
  idea: 6.2,
};

const FONT_SIZE: Record<string, number> = {
  root: 14,
  chapter: 12.5,
  section: 11.5,
  idea: 11,
};

const RECT_HEIGHT: Record<string, number> = {
  root: 32,
  chapter: 28,
  section: 24,
  idea: 22,
};

const RECT_RX: Record<string, number> = {
  root: 8,
  chapter: 6,
  section: 5,
  idea: 11, // pill shape for ideas
};

const RECT_PADDING_H: Record<string, number> = {
  root: 20,
  chapter: 16,
  section: 14,
  idea: 12,
};

/** Compute rectangle width from text content */
function nodeRectWidth(d: HNode): number {
  const name = d.data.name;
  const cw = CHAR_WIDTH[d.data.nodeType] || 6.5;
  const pad = RECT_PADDING_H[d.data.nodeType] || 14;
  const minW = RECT_HEIGHT[d.data.nodeType] || 24;
  return Math.max(minW, Math.ceil(name.length * cw + pad * 2));
}

function nodeRectHeight(d: HNode): number {
  return RECT_HEIGHT[d.data.nodeType] || 24;
}

function nodeFontPx(d: HNode): number {
  return FONT_SIZE[d.data.nodeType] || 11;
}

function nodeRx(d: HNode): number {
  return RECT_RX[d.data.nodeType] || 6;
}

// ============================================================
// Color Schemes
// ============================================================

/** Chapter spectrum: hue 0 (red) → hue 270 (violet) */
function getChapterHue(index: number, total: number): number {
  if (total <= 1) return 0;
  return (index / (total - 1)) * 270;
}

function chapterFill(hue: number): string {
  return `hsl(${Math.round(hue)}, 70%, 55%)`;
}

function chapterStroke(hue: number): string {
  return `hsl(${Math.round(hue)}, 80%, 38%)`;
}

/** Section: same hue, less saturated & lighter */
function sectionFill(hue: number, level: number): string {
  const sat = level === 2 ? 50 : 40;
  const light = level === 2 ? 60 : 66;
  return `hsl(${Math.round(hue)}, ${sat}%, ${light}%)`;
}

function sectionStroke(hue: number, level: number): string {
  const sat = level === 2 ? 60 : 50;
  const light = level === 2 ? 46 : 52;
  return `hsl(${Math.round(hue)}, ${sat}%, ${light}%)`;
}

const STATUS_COLORS: Record<IdeaStatus, string> = {
  mastered: '#22c55e',
  applied: '#16a34a',
  in_progress: '#3b82f6',
  confused: '#ef4444',
  unseen: '#9ca3af',
};

const FAMILIARITY_COLORS: Record<Familiarity, string> = {
  known: '#14b8a6',
  heard: '#eab308',
  new: '#f97316',
  unknown: '#6b7280',
};

function ideaFillColor(idea: Idea): string {
  return STATUS_COLORS[idea.status] || FAMILIARITY_COLORS[idea.familiarity] || '#6b7280';
}

function ideaStrokeColor(idea: Idea): string {
  const c = ideaFillColor(idea);
  const match = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (match) {
    const r = Math.max(0, parseInt(match[1], 16) - 40);
    const g = Math.max(0, parseInt(match[2], 16) - 40);
    const b = Math.max(0, parseInt(match[3], 16) - 40);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  return '#444';
}

function nodeFill(d: HNode): string {
  if (d.data.color) return d.data.color;
  if (d.data.idea) return ideaFillColor(d.data.idea);
  return '#555';
}

function nodeStroke(d: HNode): string {
  if (d.data.nodeType === 'root') return '#6b7280';
  if (d.data.nodeType === 'chapter') return chapterStroke(d.data.chapterHue || 0);
  if (d.data.nodeType === 'section') return sectionStroke(d.data.chapterHue || 0, d.data.tocEntry?.level || 2);
  if (d.data.idea) return ideaStrokeColor(d.data.idea);
  return '#555';
}

// ============================================================
// Idea Graph View
// ============================================================

export class IdeaGraphView {
  private container: HTMLElement;
  private bookId: string;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private gMain: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private tooltip: HTMLDivElement | null = null;
  private root: HNode | null = null;
  private treeLayout: d3.TreeLayout<TreeNodeInfo> | null = null;
  private width = 0;
  private height = 0;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  destroy(): void {
    this.svg?.remove();
    this.tooltip?.remove();
    this.svg = null;
    this.gMain = null;
    this.tooltip = null;
    this.root = null;
  }

  // ============================================================
  // Public: render
  // ============================================================

  async render(): Promise<void> {
    this.destroy();

    const book = await db.books.get(this.bookId);
    if (!book) return;

    const toc: TOCEntry[] = book.tableOfContents || [];
    const pageOffset = book.pageOffset || 0;
    const ideas = await db.ideas.where('bookId').equals(this.bookId).toArray();

    assignChapterIds(ideas, toc, pageOffset);

    const treeData = this.buildTree(book, toc, ideas, pageOffset);
    const chapters = treeData.children || [];
    const totalChapters = chapters.filter(c => c.nodeType === 'chapter').length;

    const root = d3.hierarchy<TreeNodeInfo>(treeData) as unknown as HNode;
    root.x0 = 0;
    root.y0 = 0;
    this.root = root;

    // Assign chapter hues & colors
    let chIdx = 0;
    root.children?.forEach(ch => {
      if (ch.data.nodeType !== 'chapter') return;
      const hue = getChapterHue(chIdx, totalChapters);
      ch.data.chapterIndex = chIdx;
      ch.data.chapterHue = hue;
      ch.data.color = chapterFill(hue);
      ch.data.ideaCount = this.countDescendantIdeas(ch);
      propagateHue(ch, hue);
      chIdx++;
    });

    // Assign section & idea colors
    root.descendants().forEach(d => {
      if (d.data.nodeType === 'section') {
        const level = d.data.tocEntry?.level || 2;
        d.data.color = sectionFill(d.data.chapterHue || 0, level);
      } else if (d.data.nodeType === 'idea' && d.data.idea) {
        d.data.color = ideaFillColor(d.data.idea);
        d.data.crossLinks = countCrossLinks(d.data.idea, ideas);
      }
    });

    // Collapse all by default: only chapters visible
    root.children?.forEach(ch => {
      if (ch.children) {
        ch._children = ch.children as HNode[];
        ch.children = undefined;
      }
    });

    console.log(`[Graph] Book: "${book.title}", ideas: ${ideas.length}, chapters: ${totalChapters}`);

    this.container.innerHTML = `
      <div class="graph-view">
        <div class="graph-toolbar">
          <div class="graph-toolbar-left">
            <span class="graph-title">~ Граф идей</span>
            <span class="idea-count">${ideas.length} идей</span>
          </div>
          <div class="graph-toolbar-right">
            <button class="secondary-btn btn-sm" id="btn-expand-all" title="Развернуть все">+ Развернуть</button>
            <button class="secondary-btn btn-sm" id="btn-collapse-all" title="Свернуть все">- Свернуть</button>
            <button class="secondary-btn btn-sm" id="btn-graph-fit" title="Вписать в экран">&#x2921; Масштаб</button>
          </div>
        </div>
        <div class="graph-legend" id="graph-legend"></div>
        <div class="graph-container" id="graph-wrapper">
          ${ideas.length === 0 && toc.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">~</div>
              <p>Граф пуст</p>
              <p class="empty-hint">Сначала извлеките оглавление и идеи</p>
            </div>
          ` : `
            <svg id="graph-svg" class="graph-svg"></svg>
            <div id="graph-tooltip" class="graph-tooltip"></div>
          `}
        </div>
      </div>`;

    this.renderLegend(root, totalChapters);

    if (ideas.length > 0 || toc.length > 0) {
      requestAnimationFrame(() => this.initD3());
    }

    this.bindEvents();
  }

  // ============================================================
  // Build Tree Data
  // ============================================================

  private buildTree(
    book: { id: string; title: string; pageOffset: number },
    toc: TOCEntry[],
    ideas: Idea[],
    pageOffset: number,
  ): TreeNodeInfo {
    const tocIdeaMap = new Map<string, Idea[]>();
    const unassigned: Idea[] = [];

    for (const idea of ideas) {
      const bookPage = (idea.pages[0] || 1) - pageOffset;
      let best: TOCEntry | undefined;
      for (const entry of toc) {
        const inRange = entry.page <= bookPage &&
          entry.pageEnd !== undefined &&
          bookPage <= entry.pageEnd;
        if (inRange && (!best || entry.level > best.level)) {
          best = entry;
        }
      }
      if (best) {
        const list = tocIdeaMap.get(best.id) || [];
        list.push(idea);
        tocIdeaMap.set(best.id, list);
      } else {
        unassigned.push(idea);
      }
    }

    const chapters = toc.filter(e => e.level === 1);

    const root: TreeNodeInfo = {
      id: `${book.id}_root`,
      name: book.title,
      nodeType: 'root',
    };

    const rootChildren: TreeNodeInfo[] = [];

    for (const chapter of chapters) {
      rootChildren.push(this.buildTocSubtree(chapter, toc, tocIdeaMap));
    }

    if (unassigned.length > 0) {
      rootChildren.push({
        id: `${book.id}_unassigned`,
        name: 'Без оглавления',
        nodeType: 'chapter',
        children: unassigned.map(i => ideaToNode(i)),
      });
    }

    if (rootChildren.length > 0) {
      root.children = rootChildren;
    }

    return root;
  }

  private buildTocSubtree(
    entry: TOCEntry,
    allToc: TOCEntry[],
    ideaMap: Map<string, Idea[]>,
  ): TreeNodeInfo {
    const children: TreeNodeInfo[] = [];

    for (const child of allToc.filter(e => e.parentId === entry.id)) {
      children.push(this.buildTocSubtree(child, allToc, ideaMap));
    }

    for (const idea of ideaMap.get(entry.id) || []) {
      children.push(ideaToNode(idea));
    }

    return {
      id: entry.id,
      name: entry.title,
      nodeType: entry.level === 1 ? 'chapter' : 'section',
      tocEntry: entry,
      children: children.length > 0 ? children : undefined,
    };
  }

  private countDescendantIdeas(node: d3.HierarchyNode<TreeNodeInfo>): number {
    let n = 0;
    node.each(d => { if (d.data.idea) n++; });
    return n;
  }

  // ============================================================
  // D3 Initialization
  // ============================================================

  private initD3(): void {
    const wrapper = document.getElementById('graph-wrapper');
    const svgEl = document.getElementById('graph-svg') as SVGSVGElement | null;
    if (!wrapper || !svgEl || !this.root) return;

    const rect = wrapper.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    if (this.width === 0 || this.height === 0) {
      setTimeout(() => this.initD3(), 200);
      return;
    }

    // Tree layout: [vertical gap, horizontal gap] — larger gaps for wider rects
    this.treeLayout = d3.tree<TreeNodeInfo>()
      .nodeSize([40, 260])
      .separation((a, b) => {
        if (a.data.nodeType === 'chapter' || b.data.nodeType === 'chapter') return 1.5;
        if (a.data.nodeType === 'section' || b.data.nodeType === 'section') return 1.2;
        return 0.9;
      });

    this.svg = d3.select(svgEl)
      .attr('width', this.width)
      .attr('height', this.height);

    // Defs
    const defs = this.svg.append('defs');

    defs.append('marker')
      .attr('id', 'arrow-seq')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', '#555');

    const glow = defs.append('filter')
      .attr('id', 'chapter-glow')
      .attr('x', '-20%').attr('y', '-30%')
      .attr('width', '140%').attr('height', '160%');
    glow.append('feGaussianBlur')
      .attr('stdDeviation', 2.5)
      .attr('result', 'coloredBlur');
    const feMerge = glow.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    this.gMain = this.svg.append('g')
      .attr('class', 'graph-main');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on('zoom', (event) => {
        this.gMain!.attr('transform', event.transform.toString());
      });
    this.svg.call(zoom);

    this.tooltip = document.getElementById('graph-tooltip') as HTMLDivElement;

    this.updateGraph(this.root);

    setTimeout(() => this.fitView(), 600);
  }

  // ============================================================
  // Graph Update
  // ============================================================

  private updateGraph(source: HNode): void {
    if (!this.gMain || !this.root || !this.treeLayout) return;

    const duration = 500;

    this.treeLayout(this.root);

    const allNodes = this.root.descendants() as HNode[];
    const allLinks = this.root.links() as d3.HierarchyPointLink<TreeNodeInfo>[];

    // ---- LINKS ----
    const linkSel = this.gMain
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNodeInfo>>('.tree-link')
      .data(allLinks, d => `${d.source.data.id}->${d.target.data.id}`);

    const linkEnter = linkSel.enter()
      .append('path')
      .attr('class', 'tree-link')
      .attr('fill', 'none')
      .attr('stroke-width', d => linkWidth(d))
      .attr('stroke', d => linkColor(d))
      .attr('opacity', 0)
      .attr('d', () => {
        const o: Point = { x: source.x0 ?? 0, y: source.y0 ?? 0 };
        return rectLink(o, o, 0, 0);
      });

    linkEnter.merge(linkSel as unknown as d3.Selection<SVGPathElement, d3.HierarchyPointLink<TreeNodeInfo>, SVGPathElement, unknown>)
      .transition().duration(duration)
      .attr('opacity', 1)
      .attr('d', d => {
        const sw = nodeRectWidth(d.source as HNode);
        const tw = nodeRectWidth(d.target as HNode);
        return rectLink(d.source, d.target, sw / 2, tw / 2);
      })
      .attr('stroke', d => linkColor(d))
      .attr('stroke-width', d => linkWidth(d));

    linkSel.exit()
      .transition().duration(duration)
      .attr('d', () => {
        const o: Point = { x: source.x ?? 0, y: source.y ?? 0 };
        return rectLink(o, o, 0, 0);
      })
      .attr('opacity', 0)
      .remove();

    // ---- SEQUENTIAL CHAPTER ARROWS ----
    this.gMain.selectAll<SVGPathElement, unknown>('.seq-arrow').remove();

    const visibleChapters = (this.root.children || []).filter(
      ch => ch.data.nodeType === 'chapter' && ch.x != null && ch.y != null,
    );
    for (let i = 0; i < visibleChapters.length - 1; i++) {
      const ch = visibleChapters[i];
      const next = visibleChapters[i + 1];
      const cw1 = nodeRectWidth(ch);
      const cw2 = nodeRectWidth(next);
      const sx = ch.y! + cw1 / 2;
      const sy = ch.x!;
      const tx = next.y! - cw2 / 2;
      const ty = next.x!;
      const gap = ty - sy;
      const curveOut = Math.min(60, Math.abs(gap) * 0.3 + 30);

      this.gMain.append('path')
        .attr('class', 'seq-arrow')
        .attr('d', `M ${sx} ${sy} C ${sx + curveOut} ${sy}, ${tx - curveOut} ${ty}, ${tx} ${ty}`)
        .attr('fill', 'none')
        .attr('stroke', '#555')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,4')
        .attr('marker-end', 'url(#arrow-seq)')
        .attr('opacity', 0.5);
    }

    // ---- NODES ----
    const nodeSel = this.gMain
      .selectAll<SVGGElement, HNode>('.tree-node')
      .data(allNodes, d => d.data.id);

    // Enter
    const nodeEnter = nodeSel.enter()
      .append('g')
      .attr('class', d => `tree-node node-${d.data.nodeType}`)
      .attr('transform', `translate(${source.y0 ?? 0},${source.x0 ?? 0})`)
      .style('cursor', d => d.data.idea ? 'default' : 'pointer')
      .attr('opacity', 0)
      .on('click', (event, d) => {
        if (!d.data.idea) this.toggleNode(d);
      });

    // Rectangle shape
    nodeEnter.append('rect')
      .attr('class', 'node-shape');

    // Text label
    nodeEnter.append('text')
      .attr('class', 'node-label');

    // Badge group
    nodeEnter.append('g').attr('class', 'badge-group');

    // Cross-link indicator
    nodeEnter.append('g').attr('class', 'xlink-group');

    // ---- MERGE enter + update ----
    const nodeUpdate = nodeEnter.merge(nodeSel as unknown as d3.Selection<SVGGElement, HNode, SVGGElement, unknown>);

    nodeUpdate
      .transition().duration(duration)
      .attr('transform', d => `translate(${d.y},${d.x})`)
      .attr('opacity', 1);

    // Rect shape — sized to fit text
    nodeUpdate.select('.node-shape')
      .transition().duration(duration)
      .attr('width', d => nodeRectWidth(d))
      .attr('height', d => nodeRectHeight(d))
      .attr('x', d => -nodeRectWidth(d) / 2)
      .attr('y', d => -nodeRectHeight(d) / 2)
      .attr('rx', d => nodeRx(d))
      .attr('ry', d => nodeRx(d))
      .attr('fill', d => nodeFill(d))
      .attr('stroke', d => nodeStroke(d))
      .attr('stroke-width', d => {
        if (d.data.nodeType === 'chapter') return 2.5;
        if (d.data.nodeType === 'root') return 2.5;
        return 1.5;
      })
      .attr('filter', d => d.data.nodeType === 'chapter' ? 'url(#chapter-glow)' : null);

    // Text inside rect — centered
    nodeUpdate.select('.node-label')
      .text(d => d.data.name)
      .attr('x', 0)
      .attr('y', 0)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', d => {
        if (d.data.nodeType === 'idea') return '#fff';
        return '#fff';
      })
      .attr('font-size', d => `${nodeFontPx(d)}px`)
      .attr('font-weight', d => {
        if (d.data.nodeType === 'chapter') return '600';
        if (d.data.nodeType === 'root') return '700';
        return '500';
      })
      .style('pointer-events', 'none')
      .style('text-shadow', '0 1px 2px rgba(0,0,0,0.6)');

    // Collapse badge
    nodeUpdate.each(function (d) {
      const badge = d3.select(this).select<HTMLDivElement>('.badge-group');
      badge.selectAll('*').remove();

      if (d._children && d._children.length > 0) {
        const count = collapsedCount(d);
        const rw = nodeRectWidth(d);
        const rh = nodeRectHeight(d);

        badge.append('circle')
          .attr('cx', rw / 2 - 2)
          .attr('cy', -rh / 2 + 2)
          .attr('r', 10)
          .attr('fill', '#1f2937')
          .attr('stroke', '#6b7280')
          .attr('stroke-width', 1);

        badge.append('text')
          .attr('x', rw / 2 - 2)
          .attr('y', -rh / 2 + 2)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#e5e7eb')
          .attr('font-size', '9px')
          .attr('font-weight', '700')
          .text(count > 99 ? '99+' : String(count));
      }
    });

    // Cross-link indicator
    nodeUpdate.each(function (d) {
      const xg = d3.select(this).select<HTMLDivElement>('.xlink-group');
      xg.selectAll('*').remove();

      if (d.data.crossLinks && d.data.crossLinks > 0) {
        const rw = nodeRectWidth(d);
        const rh = nodeRectHeight(d);

        xg.append('circle')
          .attr('cx', -rw / 2 - 2)
          .attr('cy', -rh / 2 + 2)
          .attr('r', 7)
          .attr('fill', '#f59e0b')
          .attr('stroke', '#92400e')
          .attr('stroke-width', 0.8);

        xg.append('text')
          .attr('x', -rw / 2 - 2)
          .attr('y', -rh / 2 + 2)
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'central')
          .attr('fill', '#fff')
          .attr('font-size', '7px')
          .attr('font-weight', '800')
          .text(String(d.data.crossLinks));
      }
    });

    // Hover tooltips
    nodeUpdate
      .on('mouseenter', (event, d) => this.showTooltip(event, d))
      .on('mousemove', (event) => this.moveTooltip(event))
      .on('mouseleave', () => this.hideTooltip());

    // ---- EXIT ----
    const nodeExit = nodeSel.exit()
      .transition().duration(duration)
      .attr('transform', `translate(${source.y ?? 0},${source.x ?? 0})`)
      .attr('opacity', 0)
      .remove();

    // Store positions
    allNodes.forEach(d => {
      d.x0 = d.x ?? 0;
      d.y0 = d.y ?? 0;
    });
  }

  // ============================================================
  // Toggle collapse / expand
  // ============================================================

  private toggleNode(d: HNode): void {
    if (d.children) {
      d._children = d.children;
      d.children = undefined;
    } else if (d._children) {
      d.children = d._children;
      d._children = undefined;
    }
    this.updateGraph(d);
  }

  expandAll(): void {
    if (!this.root) return;
    this.root.each(d => {
      const h = d as unknown as HNode;
      if (h._children) {
        h.children = h._children;
        h._children = undefined;
      }
    });
    this.updateGraph(this.root);
    setTimeout(() => this.fitView(), 550);
  }

  collapseAll(): void {
    if (!this.root) return;
    this.root.children?.forEach(ch => collapseDeep(ch));
    this.updateGraph(this.root);
    setTimeout(() => this.fitView(), 550);
  }

  // ============================================================
  // Tooltip
  // ============================================================

  private showTooltip(event: MouseEvent, d: HNode): void {
    if (!this.tooltip) return;
    const tt = this.tooltip;

    if (d.data.idea) {
      const i = d.data.idea;
      tt.innerHTML = `
        <div class="tt-title">${esc(i.title)}</div>
        <div class="tt-type">${i.type} · глубина: ${i.depth} · важность: ${i.importance}/5</div>
        ${i.summary ? `<div class="tt-body">${esc(i.summary)}</div>` : ''}
        <div class="tt-meta">Стр.: ${i.pages.join(', ')}</div>
        <div class="tt-meta">Статус: ${STATUS_LABELS[i.status]}</div>
        <div class="tt-meta">Знакомство: ${FAM_LABELS[i.familiarity]}</div>
        ${d.data.crossLinks ? `<div class="tt-xlink">Связи с другими главами: ${d.data.crossLinks}</div>` : ''}
      `;
    } else if (d.data.tocEntry) {
      const t = d.data.tocEntry;
      const lvl = t.level === 1 ? 'Глава' : t.level === 2 ? 'Раздел' : 'Подраздел';
      tt.innerHTML = `
        <div class="tt-title">${esc(t.title)}</div>
        <div class="tt-type">${lvl} (уровень ${t.level})</div>
        <div class="tt-meta">Стр.: ${t.page}${t.pageEnd ? '–' + t.pageEnd : ''}</div>
        ${t.summary ? `<div class="tt-body">${esc(t.summary)}</div>` : ''}
        ${d.data.ideaCount !== undefined ? `<div class="tt-meta">Идей в ветке: ${d.data.ideaCount}</div>` : ''}
      `;
    } else {
      tt.innerHTML = `<div class="tt-title">${esc(d.data.name)}</div>`;
    }

    tt.classList.add('visible');
    this.moveTooltip(event);
  }

  private moveTooltip(event: MouseEvent): void {
    if (!this.tooltip) return;
    const x = event.clientX + 14;
    const y = event.clientY - 10;
    const rect = this.tooltip.getBoundingClientRect();
    const maxX = window.innerWidth - (rect.width || 200) - 8;
    const maxY = window.innerHeight - (rect.height || 100) - 8;
    this.tooltip.style.left = Math.min(x, maxX) + 'px';
    this.tooltip.style.top = Math.min(y, maxY) + 'px';
  }

  private hideTooltip(): void {
    if (!this.tooltip) return;
    this.tooltip.classList.remove('visible');
  }

  // ============================================================
  // Legend
  // ============================================================

  private renderLegend(root: d3.HierarchyNode<TreeNodeInfo>, total: number): void {
    const el = document.getElementById('graph-legend');
    if (!el) return;

    const chapters = (root.children || []).filter(c => c.data.nodeType === 'chapter');

    let html = '<div class="legend-group">';
    html += '<span class="legend-title">Главы:</span>';
    chapters.forEach(ch => {
      const color = ch.data.color || '#888';
      const name = ch.data.name.length > 25 ? ch.data.name.substring(0, 23) + '…' : ch.data.name;
      const cnt = ch.data.ideaCount ?? 0;
      html += `<span class="legend-chip"><span class="legend-dot" style="background:${color}"></span>${esc(name)} (${cnt})</span>`;
    });
    html += '</div>';

    html += '<div class="legend-group">';
    html += '<span class="legend-title">Статус идей:</span>';
    const statuses: Array<[string, string]> = [
      ['Освоена', STATUS_COLORS.mastered],
      ['Применена', STATUS_COLORS.applied],
      ['В процессе', STATUS_COLORS.in_progress],
      ['Знакомая', FAMILIARITY_COLORS.known],
      ['Слышал', FAMILIARITY_COLORS.heard],
      ['Новая', FAMILIARITY_COLORS.new],
      ['Не понята', STATUS_COLORS.confused],
    ];
    for (const [label, color] of statuses) {
      html += `<span class="legend-chip"><span class="legend-dot" style="background:${color}"></span>${label}</span>`;
    }
    html += '</div>';

    html += '<div class="legend-group">';
    html += '<span class="legend-title">Пометки:</span>';
    html += '<span class="legend-chip"><span class="xlink-badge-legend">N</span> кросс-связи</span>';
    html += '<span class="legend-chip"><span class="seq-line-legend"></span> порядок глав</span>';
    html += '</div>';

    el.innerHTML = html;
  }

  // ============================================================
  // View controls
  // ============================================================

  private fitView(): void {
    if (!this.svg || !this.gMain || !this.root) return;

    const el = this.gMain.node() as SVGGElement | null;
    if (!el) return;
    const bbox = el.getBBox();
    if (bbox.width === 0 || bbox.height === 0) return;

    const pad = 60;
    const scale = Math.min(
      (this.width - pad * 2) / bbox.width,
      (this.height - pad * 2) / bbox.height,
      1.5,
    );
    const tx = this.width / 2 - (bbox.x + bbox.width / 2) * scale;
    const ty = this.height / 2 - (bbox.y + bbox.height / 2) * scale;

    this.svg.transition().duration(750).call(
      d3.zoom<SVGSVGElement, unknown>().transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale),
    );
  }

  private bindEvents(): void {
    document.getElementById('btn-graph-fit')?.addEventListener('click', () => this.fitView());
    document.getElementById('btn-expand-all')?.addEventListener('click', () => this.expandAll());
    document.getElementById('btn-collapse-all')?.addEventListener('click', () => this.collapseAll());
  }
}

// ============================================================
// Constants
// ============================================================

const STATUS_LABELS: Record<IdeaStatus, string> = {
  unseen: 'Не просмотрена',
  in_progress: 'В процессе',
  mastered: 'Освоена',
  applied: 'Применена',
  confused: 'Не понята',
};

const FAM_LABELS: Record<Familiarity, string> = {
  unknown: 'Неизвестно',
  known: 'Знакомая',
  heard: 'Слышал',
  new: 'Новая',
};

// ============================================================
// Pure helper functions
// ============================================================

/**
 * Horizontal tree link between rect edges.
 * Connects from source right edge to target left edge.
 */
function rectLink(s: Point, d: Point, halfW_source: number, halfW_target: number): string {
  const sx = s.y + halfW_source;
  const dx = d.y - halfW_target;
  const midX = (sx + dx) / 2;
  return `M ${sx} ${s.x} C ${midX} ${s.x}, ${midX} ${d.x}, ${dx} ${d.x}`;
}

function propagateHue(node: d3.HierarchyNode<TreeNodeInfo>, hue: number): void {
  node.data.chapterHue = hue;
  node.children?.forEach(ch => propagateHue(ch, hue));
}

function collapseDeep(node: HNode): void {
  if (node.children) {
    node.children.forEach(ch => collapseDeep(ch));
    node._children = node.children;
    node.children = undefined;
  }
}

function collapsedCount(node: HNode): number {
  let count = 0;
  const walk = (nd: HNode) => {
    if (nd._children) nd._children.forEach(c => { count++; walk(c); });
    if (nd.children) nd.children.forEach(c => { count++; walk(c); });
  };
  walk(node);
  return count;
}

function countCrossLinks(idea: Idea, allIdeas: Idea[]): number {
  const chapterOf = new Map<string, string>();
  for (const i of allIdeas) chapterOf.set(i.id, i.chapterId || '');
  return idea.relations.filter(r => {
    const ch = chapterOf.get(r.targetId);
    return ch !== undefined && ch !== idea.chapterId;
  }).length;
}

function ideaToNode(idea: Idea): TreeNodeInfo {
  return {
    id: idea.id,
    name: idea.title,
    nodeType: 'idea',
    idea,
  };
}

function linkWidth(d: d3.HierarchyPointLink<TreeNodeInfo>): number {
  if (d.target.data.nodeType === 'chapter') return 2;
  if (d.target.data.nodeType === 'section') return 1.6;
  return 1.2;
}

function linkColor(d: d3.HierarchyPointLink<TreeNodeInfo>): string {
  const t = d.target;
  if (t.data.nodeType === 'chapter') return chapterStroke(t.data.chapterHue || 0);
  if (t.data.nodeType === 'section') return sectionStroke(t.data.chapterHue || 0, t.data.tocEntry?.level || 2);
  if (t.data.idea) return 'rgba(255,255,255,0.15)';
  return 'rgba(255,255,255,0.08)';
}

function esc(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
