// ============================================================
// Idea Graph View — D3 SVG mind-map with collapsible branches
//
// Tree structure: Book → Chapters → Sections → Ideas
// - Nodes are rounded rectangles with text INSIDE (mindmap style)
// - Text wraps to multiple lines when exceeding max width
// - Node height grows dynamically to fit wrapped text
// - Tree spacing adapts to actual node heights
// - Collapsible branches with count badges
// - Auto-pan: expand centers node, collapse centers parent
// - Chapter spectrum: red → violet
// - Idea colors: by mastery status / familiarity
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
  strokeColor?: string;
  ideaCount?: number;
  crossLinks?: number;
  // Layout dimensions (computed once before D3 layout)
  wrappedLines?: string[];
  rectW?: number;
  rectH?: number;
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
// Node Dimension Constants
// ============================================================

/** Max pixel width per node type — text wraps beyond this */
const MAX_WIDTH: Record<string, number> = {
  root: 220,
  chapter: 200,
  section: 180,
  idea: 160,
};

const FONT_SIZE: Record<string, number> = {
  root: 13,
  chapter: 12,
  section: 11,
  idea: 10.5,
};

/** Approximate px per character for Cyrillic at given font size */
const CHAR_PX: Record<string, number> = {
  root: 7.5,
  chapter: 7.0,
  section: 6.5,
  idea: 6.2,
};

const V_PADDING = 8;          // total vertical padding (top + bottom)
const LINE_HEIGHT_RATIO = 1.3; // line-height relative to font-size
const MIN_RECT_H: Record<string, number> = {
  root: 30,
  chapter: 26,
  section: 22,
  idea: 20,
};

const RECT_RX: Record<string, number> = {
  root: 8,
  chapter: 6,
  section: 5,
  idea: 10, // pill shape
};

// ============================================================
// Text Wrapping & Dimension Computation
// ============================================================

/**
 * Wrap text to fit within maxWidth pixels.
 * Returns array of lines.
 */
function wrapText(text: string, charPx: number, maxPx: number): string[] {
  const maxChars = Math.max(5, Math.floor(maxPx / charPx));
  if (text.length <= maxChars) return [text];

  // Try to break at spaces (Cyrillic uses regular spaces)
  const words = text.split(/\s+/);
  if (words.length <= 1) {
    // Single long word — hard-break at maxChars
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      lines.push(text.substring(i, i + maxChars));
    }
    return lines;
  }

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : current + ' ' + word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // If a single word exceeds maxChars, break it
      if (word.length > maxChars) {
        for (let i = 0; i < word.length; i += maxChars) {
          lines.push(word.substring(i, i + maxChars));
        }
        current = '';
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Pre-compute wrapped lines, rect width, and rect height for a node.
 */
function computeDimensions(info: TreeNodeInfo): void {
  const nt = info.nodeType;
  const charPx = CHAR_PX[nt] || 6.5;
  const maxPx = MAX_WIDTH[nt] || 180;
  const fontSize = FONT_SIZE[nt] || 11;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const padH = RECT_PADDING_H(nt);

  const lines = wrapText(info.name, charPx, maxPx);
  info.wrappedLines = lines;

  // Rect width: max of all line widths (in px) + horizontal padding
  let maxLinePx = 0;
  for (const line of lines) {
    maxLinePx = Math.max(maxLinePx, line.length * charPx);
  }
  info.rectW = Math.max(MIN_RECT_H[nt] || 24, maxLinePx + padH * 2);

  // Rect height: lines * lineHeight + vertical padding
  const minH = MIN_RECT_H[nt] || 22;
  info.rectH = Math.max(minH, lines.length * lineHeight + V_PADDING);
}

function RECT_PADDING_H(nt: string): number {
  switch (nt) {
    case 'root': return 18;
    case 'chapter': return 14;
    case 'section': return 12;
    case 'idea': return 10;
    default: return 12;
  }
}

// ============================================================
// Color Schemes
// ============================================================

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
  return d.data.color || '#555';
}

function nodeStroke(d: HNode): string {
  if (d.data.strokeColor) return d.data.strokeColor;
  if (d.data.nodeType === 'root') return '#6b7280';
  if (d.data.nodeType === 'chapter') return chapterStroke(d.data.chapterHue || 0);
  if (d.data.nodeType === 'section') return sectionStroke(d.data.chapterHue || 0, d.data.tocEntry?.level || 2);
  if (d.data.idea) return ideaStrokeColor(d.data.idea);
  return '#555';
}

function getRectW(d: HNode): number { return d.data.rectW || 80; }
function getRectH(d: HNode): number { return d.data.rectH || 26; }
function getRx(d: HNode): number { return RECT_RX[d.data.nodeType] || 6; }
function getFontPx(d: HNode): number { return FONT_SIZE[d.data.nodeType] || 11; }

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
  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  private width = 0;
  private height = 0;
  private focusedNode: HNode | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(container: HTMLElement, bookId: string) {
    this.container = container;
    this.bookId = bookId;
  }

  destroy(): void {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    this.focusedNode = null;
    this.svg?.remove();
    this.tooltip?.remove();
    this.svg = null;
    this.gMain = null;
    this.tooltip = null;
    this.root = null;
    this.zoomBehavior = null;
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
      ch.data.strokeColor = chapterStroke(hue);
      ch.data.ideaCount = this.countDescendantIdeas(ch);
      propagateHue(ch, hue);
      chIdx++;
    });

    // Assign section & idea colors
    root.descendants().forEach(d => {
      if (d.data.nodeType === 'section') {
        const level = d.data.tocEntry?.level || 2;
        const hue = d.data.chapterHue || 0;
        d.data.color = sectionFill(hue, level);
        d.data.strokeColor = sectionStroke(hue, level);
      } else if (d.data.nodeType === 'idea' && d.data.idea) {
        d.data.color = ideaFillColor(d.data.idea);
        d.data.strokeColor = ideaStrokeColor(d.data.idea);
        d.data.crossLinks = countCrossLinks(d.data.idea, ideas);
      }
    });

    // ---- Pre-compute dimensions for ALL nodes (including hidden ones) ----
    root.each(d => computeDimensions(d.data));

    // Collapse all by default
    root.children?.forEach(ch => {
      if (ch.children) {
        ch._children = ch.children as HNode[];
        ch.children = undefined;
      }
    });

    console.log(`[Graph] Book: "${book.title}", ideas: ${ideas.length}, chapters: ${totalChapters}`);

    this.container.innerHTML = `
      <div class="graph-view">
        <div class="graph-container" id="graph-wrapper">
          ${ideas.length === 0 && toc.length === 0 ? `
            <div class="empty-state">
              <div class="empty-icon">~</div>
              <p>Граф пуст</p>
              <p class="empty-hint">Сначала извлеките оглавление и идеи</p>
            </div>
          ` : `
            <svg id="graph-svg" class="graph-svg"></svg>
          `}
          <div id="graph-tooltip" class="graph-tooltip"></div>
        </div>
        <div class="graph-overlay graph-toolbar-overlay">
          <span class="graph-title">~ Граф идей</span>
          <span class="idea-count">${ideas.length} идей</span>
          <div class="graph-btn-group">
            <button class="graph-overlay-btn" id="btn-expand-all" title="Развернуть все">+ Развернуть</button>
            <button class="graph-overlay-btn" id="btn-collapse-all" title="Свернуть все">- Свернуть</button>
            <button class="graph-overlay-btn" id="btn-graph-fit" title="Вписать в экран">&#x2921; Масштаб</button>
          </div>
        </div>
        <div class="graph-overlay graph-legend" id="graph-legend"></div>
      </div>`;

    this.renderLegend();

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

    // Tree layout: nodeSize[0] = 1px base, separation() handles real spacing
    this.treeLayout = d3.tree<TreeNodeInfo>()
      .nodeSize([1, 420])
      .separation((a, b) => {
        // Vertical gap = half-heights + minimum gap between rects
        const hA = a.data.rectH || 26;
        const hB = b.data.rectH || 26;
        const gap = 12;
        return (hA + hB) / 2 + gap;
      });

    this.svg = d3.select(svgEl)
      .attr('width', this.width)
      .attr('height', this.height);

    const defs = this.svg.append('defs');

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
    this.zoomBehavior = zoom;
    this.svg.call(zoom);

    this.tooltip = document.getElementById('graph-tooltip') as HTMLDivElement;

    // Keyboard navigation
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    document.addEventListener('keydown', this.keydownHandler);

    // Click on SVG background → clear focus
    this.svg.on('click', (event: MouseEvent) => {
      if (event.target === svgEl) {
        this.focusedNode = null;
        this.gMain?.selectAll('.focus-ring').remove();
      }
    });

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
        const sw = getRectW(d.source as HNode) / 2;
        const tw = getRectW(d.target as HNode) / 2;
        return rectLink(d.source, d.target, sw, tw);
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
        this.focusedNode = d;
        if (!d.data.idea) {
          this.toggleNode(d);
        } else {
          this.redrawFocusRing();
        }
      });

    // Rectangle shape
    nodeEnter.append('rect').attr('class', 'node-shape');

    // Text label (container for tspan children)
    nodeEnter.append('text').attr('class', 'node-label');

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

    // ---- Rect shape ----
    nodeUpdate.select('.node-shape')
      .transition().duration(duration)
      .attr('width', d => getRectW(d))
      .attr('height', d => getRectH(d))
      .attr('x', d => -getRectW(d) / 2)
      .attr('y', d => -getRectH(d) / 2)
      .attr('rx', d => getRx(d))
      .attr('ry', d => getRx(d))
      .attr('fill', d => nodeFill(d))
      .attr('stroke', d => nodeStroke(d))
      .attr('stroke-width', d => {
        if (d.data.nodeType === 'chapter') return 2.5;
        if (d.data.nodeType === 'root') return 2.5;
        return 1.5;
      })
      .attr('filter', d => d.data.nodeType === 'chapter' ? 'url(#chapter-glow)' : null);

    // ---- Text with multi-line tspan ----
    nodeUpdate.each(function (d) {
      const textEl = d3.select(this).select<SVGTextElement>('.node-label');
      textEl.selectAll('tspan').remove();

      const lines = d.data.wrappedLines || [d.data.name];
      const fontSize = getFontPx(d);
      const lineHeight = fontSize * LINE_HEIGHT_RATIO;
      const totalBlockH = (lines.length - 1) * lineHeight;

      lines.forEach((line, i) => {
        textEl.append('tspan')
          .attr('x', 0)
          .attr('dy', i === 0 ? -totalBlockH / 2 : lineHeight)
          .text(line);
      });

      textEl
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('fill', '#fff')
        .attr('font-size', `${fontSize}px`)
        .attr('font-weight', d.data.nodeType === 'chapter' || d.data.nodeType === 'root' ? '600' : '500')
        .style('pointer-events', 'none');
    });

    // ---- Collapse badge ----
    nodeUpdate.each(function (d) {
      const badge = d3.select(this).select<HTMLDivElement>('.badge-group');
      badge.selectAll('*').remove();

      if (d._children && d._children.length > 0) {
        const count = collapsedCount(d);
        const rw = getRectW(d);
        const rh = getRectH(d);

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

    // ---- Cross-link indicator ----
    nodeUpdate.each(function (d) {
      const xg = d3.select(this).select<HTMLDivElement>('.xlink-group');
      xg.selectAll('*').remove();

      if (d.data.crossLinks && d.data.crossLinks > 0) {
        const rw = getRectW(d);
        const rh = getRectH(d);

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

    // Hover
    nodeUpdate
      .on('mouseenter', (event, d) => this.showTooltip(event, d))
      .on('mousemove', (event) => this.moveTooltip(event))
      .on('mouseleave', () => this.hideTooltip());

    // ---- EXIT ----
    nodeSel.exit()
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
    const isExpanding = !!d._children;
    if (d.children) {
      d._children = d.children;
      d.children = undefined;
    } else if (d._children) {
      d.children = d._children;
      d._children = undefined;
    }
    this.updateGraph(d);
    this.focusedNode = d;
    setTimeout(() => this.redrawFocusRing(), 530);

    // Auto-pan only on expand: node moves to left, children visible to the right
    if (isExpanding) {
      setTimeout(() => this.panNodeToLeft(d), 530);
    }
    // Collapsing: no pan animation
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

  private renderLegend(): void {
    const el = document.getElementById('graph-legend');
    if (!el) return;

    let html = '';

    // Idea status colors
    html += '<div class="legend-group">';
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

    // Badges
    html += '<div class="legend-group">';
    html += '<span class="legend-chip"><span class="xlink-badge-legend">N</span> кросс-связи</span>';
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

    const pad = 10; // minimal padding — use every pixel
    const scale = Math.min(
      (this.width - pad * 2) / bbox.width,
      (this.height - pad * 2) / bbox.height,
      1.5,
    );
    const tx = this.width / 2 - (bbox.x + bbox.width / 2) * scale;
    const ty = this.height / 2 - (bbox.y + bbox.height / 2) * scale;

    this.svg.transition().duration(750).call(
      this.zoomBehavior!.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale),
    );
  }

  /**
   * Smooth-pan so that a node appears at the LEFT portion of the screen,
   * vertically centered. Children will be visible to the right.
   */
  private panNodeToLeft(d: HNode): void {
    if (!this.svg || !this.zoomBehavior || d.x == null || d.y == null) return;

    const currentTransform = d3.zoomTransform(this.svg.node()!);
    const currentScale = currentTransform.k;

    // Position the node at ~15% from the left edge of the viewport
    const leftMargin = this.width * 0.15;
    const verticalCenter = this.height / 2;

    // Calculate translation to place node at (leftMargin, verticalCenter)
    const tx = leftMargin - d.y * currentScale;
    const ty = verticalCenter - d.x * currentScale;

    this.svg.transition().duration(600).ease(d3.easeCubicInOut).call(
      this.zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(currentScale),
    );
  }

  /**
   * Smooth-pan so that a node's PARENT appears on the left side of the screen.
   */
  private panParentToLeft(d: HNode): void {
    const parent = d.parent as HNode | undefined;
    if (parent) {
      this.panNodeToLeft(parent);
    }
  }

  // ============================================================
  // Keyboard Navigation
  // ============================================================

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.root || !this.focusedNode) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.navigateVertical(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.navigateVertical(1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.navigateRight();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.navigateLeft();
        break;
      case ' ':
        e.preventDefault();
        if (!this.focusedNode.data.idea) {
          this.toggleNode(this.focusedNode);
        }
        break;
    }
  }

  /** Navigate up (direction=-1) or down (direction=+1) among siblings. */
  private navigateVertical(direction: -1 | 1): void {
    const d = this.focusedNode;
    if (!d) return;

    const siblings = this.getVisibleSiblings(d);
    const idx = siblings.indexOf(d);
    if (idx < 0) return;

    const nextIdx = idx + direction;
    if (nextIdx >= 0 && nextIdx < siblings.length) {
      this.setFocus(siblings[nextIdx]);
    }
  }

  /** Right arrow: expand collapsed children + focus first child, or just focus first child if already expanded. */
  private navigateRight(): void {
    const d = this.focusedNode;
    if (!d) return;

    if (d._children) {
      // Has collapsed children → expand + pan to parent + then focus first child
      d.children = d._children;
      d._children = undefined;
      this.updateGraph(d);

      const treeAnimMs = 500;
      const panToParentMs = 600;

      // Step 1: after tree animation finishes, pan parent to the left
      setTimeout(() => {
        this.panNodeToLeft(d);

        // Step 2: after pan-to-parent finishes, focus first child and pan to it
        setTimeout(() => {
          const firstChild = d.children?.[0] as HNode | undefined;
          if (firstChild) {
            this.focusedNode = firstChild;
            this.redrawFocusRing();
            this.panToMakeNodeVisible(firstChild);
          }
        }, panToParentMs + 60);
      }, treeAnimMs + 40);
    } else if (d.children?.[0]) {
      // Already expanded → just focus first child
      this.setFocus(d.children[0] as HNode);
    }
  }

  /** Left arrow: collapse if expanded (keep focus), or move to parent if leaf/collapsed. */
  private navigateLeft(): void {
    const d = this.focusedNode;
    if (!d) return;

    if (d.children) {
      // Has expanded children → collapse, keep focus on this node
      d._children = d.children;
      d.children = undefined;
      this.updateGraph(d);
      // Keep focusedNode = d (already set)
      setTimeout(() => this.redrawFocusRing(), 530);
      // No pan on collapse
    } else {
      // No children (leaf or already collapsed) → move focus to parent
      const parent = d.parent as HNode | undefined;
      if (parent) {
        this.setFocus(parent);
      }
    }
  }

  /** Get visible siblings of a node (nodes at the same level, under the same parent). */
  private getVisibleSiblings(node: HNode): HNode[] {
    const parent = node.parent as HNode | undefined;
    if (!parent) {
      // Root level
      if (this.root && this.root.children) {
        return this.root.children as HNode[];
      }
      return this.root ? [this.root] : [node];
    }
    return (parent.children || []) as HNode[];
  }

  /** Set focus on a node, redraw ring, pan if needed. */
  private setFocus(node: HNode): void {
    this.focusedNode = node;
    setTimeout(() => this.redrawFocusRing(), 30);
    this.panToMakeNodeVisible(node);
  }

  // ============================================================
  // Focus ring
  // ============================================================

  private redrawFocusRing(): void {
    if (!this.gMain || !this.root) return;

    this.gMain.selectAll('.focus-ring').remove();

    const d = this.focusedNode;
    if (!d || !this.isNodeInVisibleTree(d)) return;

    const rw = getRectW(d);
    const rh = getRectH(d);

    this.gMain.append('rect')
      .attr('class', 'focus-ring')
      .attr('x', d.y - rw / 2 - 4)
      .attr('y', d.x - rh / 2 - 4)
      .attr('width', rw + 8)
      .attr('height', rh + 8)
      .attr('rx', getRx(d) + 2)
      .attr('ry', getRx(d) + 2)
      .attr('fill', 'none')
      .attr('stroke', '#3b82f6')
      .attr('stroke-width', 2.5)
      .attr('pointer-events', 'none');
  }

  /** Check if a node is in the currently visible tree (all ancestors expanded). */
  private isNodeInVisibleTree(node: HNode): boolean {
    let current = node.parent as HNode | undefined;
    while (current) {
      if (!current.children) return false; // ancestor is collapsed
      current = current.parent as HNode | undefined;
    }
    return true;
  }

  // ============================================================
  // Pan to make node visible
  // ============================================================

  /** Pan the view so the given node is visible in the viewport. No-op if already visible. */
  private panToMakeNodeVisible(node: HNode): void {
    if (!this.svg || !this.zoomBehavior || !this.gMain) return;
    if (node.x == null || node.y == null) return;

    const svgEl = this.svg.node()!;
    const transform = d3.zoomTransform(svgEl);
    const scale = transform.k;

    // Node center in screen coordinates
    const nodeScreenX = node.y * scale + transform.x;
    const nodeScreenY = node.x * scale + transform.y;

    const rw = getRectW(node) * scale;
    const rh = getRectH(node) * scale;
    const margin = 60;

    // Check if node is within viewport (with margin)
    const inView =
      nodeScreenX - rw / 2 >= margin &&
      nodeScreenX + rw / 2 <= this.width - margin &&
      nodeScreenY - rh / 2 >= margin &&
      nodeScreenY + rh / 2 <= this.height - margin;

    if (inView) return;

    // Pan to center the node in viewport
    const tx = this.width / 2 - node.y * scale;
    const ty = this.height / 2 - node.x * scale;

    this.svg.transition().duration(500).ease(d3.easeCubicInOut).call(
      this.zoomBehavior.transform,
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
 * Horizontal tree link: right edge of source rect → left edge of target rect.
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
