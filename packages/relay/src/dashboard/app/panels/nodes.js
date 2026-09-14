// nodes — 左侧节点列表面板,变化区
// 纯渲染函数(可测) + 薄 DOM 绑定(mount)
import { escapeHtml } from "../core/util.js"

export function nodeCardHtml(node, activeNodeId) {
  const id = node.identity
  const active = id.nodeId === activeNodeId ? " active" : ""
  return (
    `<div class="node${active}" data-node-id="${escapeHtml(id.nodeId)}">` +
    `<div class="id">${escapeHtml(id.shortId)}</div>` +
    `<div class="meta">${escapeHtml(id.role)} · ${escapeHtml(id.description || "")}</div>` +
    `<div class="meta">${escapeHtml(node.sessionId)}</div>` +
    `</div>`
  )
}

export function nodeListHtml(nodes, activeNodeId) {
  return [...nodes.values()].map((n) => nodeCardHtml(n, activeNodeId)).join("")
}

export function mountNodes({ el, store, onSelect }) {
  function render() {
    const st = store.get()
    el.innerHTML = nodeListHtml(st.nodes, st.active.nodeId)
    el.querySelectorAll(".node").forEach((card) => {
      card.addEventListener("click", () => {
        const node = st.nodes.get(card.getAttribute("data-node-id"))
        if (node) onSelect(node)
      })
    })
  }
  store.subscribe(render)
  render()
}
