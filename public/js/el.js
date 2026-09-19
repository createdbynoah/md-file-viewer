// public/js/el.js
/** createElement + props + children, for DOM built without innerHTML. */
export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}
