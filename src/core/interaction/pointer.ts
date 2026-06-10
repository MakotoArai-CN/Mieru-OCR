/**
 * 合成指针/鼠标事件派发，用于模拟拖拽与点击。
 *
 * 要点：
 *  - 同时派发 PointerEvent 与 MouseEvent：现代滑块库多用 pointer 事件，老库用 mouse 事件。
 *  - move / up 同时派发到目标元素与 document：很多库在 pointerdown 后把 move/up 监听挂到
 *    document / window 上，只派发到 handle 会收不到。
 *  - 坐标用 clientX/clientY（视口坐标系）。
 *
 * 局限：合成事件 isTrusted=false。仅读取 clientX/clientY 的普通库可正常工作；带行为风控
 * （轨迹指纹 / isTrusted 校验）的高级验证码（如 GeeTest 行为层、Cloudflare）不保证通过。
 */

import type { TrajectoryStep, Point } from './trajectory';

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function viewOf(target: EventTarget): Window {
  const doc = (target as Node).ownerDocument || document;
  return doc.defaultView || window;
}

function firePointer(target: EventTarget, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  if (typeof PointerEvent === 'undefined') return;
  const ev = new PointerEvent(type, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    view: viewOf(target),
    ...extra,
  });
  target.dispatchEvent(ev);
}

function fireMouse(target: EventTarget, type: string, x: number, y: number, extra: MouseEventInit = {}): void {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    view: viewOf(target),
    ...extra,
  });
  target.dispatchEvent(ev);
}

/** 在 (x,y) 处对 handle 起手：pointerdown + mousedown。 */
export function pressDown(handle: HTMLElement, x: number, y: number): void {
  try { (handle as any).setPointerCapture?.(1); } catch { /* ignore */ }
  firePointer(handle, 'pointerdown', x, y);
  fireMouse(handle, 'mousedown', x, y);
}

/** 移动到 (x,y)：在 handle 与 document 上各派发一遍 move。 */
export function moveTo(handle: HTMLElement, x: number, y: number): void {
  const doc = handle.ownerDocument || document;
  firePointer(handle, 'pointermove', x, y);
  fireMouse(handle, 'mousemove', x, y);
  firePointer(doc, 'pointermove', x, y);
  fireMouse(doc, 'mousemove', x, y);
}

/** 抬起：pointerup + mouseup（handle 与 document 各一遍）。 */
export function release(handle: HTMLElement, x: number, y: number): void {
  const doc = handle.ownerDocument || document;
  try { (handle as any).releasePointerCapture?.(1); } catch { /* ignore */ }
  firePointer(handle, 'pointerup', x, y);
  fireMouse(handle, 'mouseup', x, y);
  firePointer(doc, 'pointerup', x, y);
  fireMouse(doc, 'mouseup', x, y);
}

/**
 * 按轨迹拖拽 handle。轨迹的 x/y 是相对起点的位移；起点取 handle 当前中心。
 * @returns 实际终点的 clientX
 */
export async function dragAlong(handle: HTMLElement, trajectory: TrajectoryStep[]): Promise<number> {
  const rect = handle.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;

  pressDown(handle, startX, startY);
  await delay(40 + Math.random() * 60); // 起手到首次移动的自然停顿

  let lastX = startX;
  for (const step of trajectory) {
    await delay(step.dt);
    lastX = startX + step.x;
    moveTo(handle, lastX, startY + step.y);
  }

  await delay(50 + Math.random() * 60);
  release(handle, lastX, startY);
  return lastX;
}

/**
 * 沿贝塞尔路径把鼠标移动到目标点并点击（用于点选）。
 * 在 document 上做 move，最后在落点元素上 down/up/click。
 */
export async function moveAndClick(path: Point[], rootDoc: Document = document): Promise<void> {
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    firePointer(rootDoc, 'pointermove', p.x, p.y);
    fireMouse(rootDoc, 'mousemove', p.x, p.y);
    await delay(8 + Math.random() * 14);
  }
  const last = path[path.length - 1];
  const target = rootDoc.elementFromPoint(last.x, last.y) || rootDoc.body;
  firePointer(target, 'pointerdown', last.x, last.y);
  fireMouse(target, 'mousedown', last.x, last.y);
  await delay(40 + Math.random() * 80); // 自然的按下时长
  firePointer(target, 'pointerup', last.x, last.y);
  fireMouse(target, 'mouseup', last.x, last.y);
  fireMouse(target, 'click', last.x, last.y);
}
