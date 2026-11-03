export type Child = Node | string | number | null | undefined | false | Child[]

type Props = Record<string, any>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as any)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  append(el, children)
  return el
}

export function append(el: Element, children: Child[]) {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
}

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren()
  append(el, children)
}

/** 分段按钮组。 */
export function segmented<T extends string>(options: { value: T; label: string; title?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const root = h('div', { class: 'seg', role: 'radiogroup' })
  for (const o of options) {
    root.append(
      h('button', {
        type: 'button', class: o.value === value ? 'on' : '', title: o.title, role: 'radio', 'aria-checked': String(o.value === value),
        onclick: () => onChange(o.value),
      }, o.label),
    )
  }
  return root
}

export function select(options: { value: string; label: string; group?: string; title?: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) })
  const groups = new Map<string, HTMLOptGroupElement>()
  for (const o of options) {
    const opt = h('option', { value: o.value, title: o.title }, o.label)
    if (o.group) {
      let g = groups.get(o.group)
      if (!g) groups.set(o.group, (g = h('optgroup', { label: o.group })))
      g.append(opt)
      el.append(g)
    } else el.append(opt)
  }
  el.value = value
  return el
}

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const el = h('div', { class: `toast ${kind}` }, text)
  document.body.append(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 300)
  }, 3200)
}
