/**
 * 人类化拖拽轨迹生成。移植自 test/experiments/slider-puzzle.html 的 generateTrajectory：
 * 分三段（加速 → 减速 → 超调回退微调）并叠加手抖，避免匀速直线这种明显的机器特征。
 *
 * 纯计算，无 DOM 依赖。输出的 x 是相对起点的累计位移。
 */

export interface TrajectoryStep {
  /** 相对起点的累计水平位移（px） */
  x: number;
  /** 相对起点的垂直抖动（px，通常 ±几像素） */
  y: number;
  /** 距上一步的时间间隔（ms） */
  dt: number;
}

/**
 * 生成到目标距离 distance 的拖拽轨迹。
 * @param distance 目标水平位移（px）
 * @param rand 可注入的随机源（默认 Math.random），便于测试可复现。
 */
export function humanDragTrajectory(distance: number, rand: () => number = Math.random): TrajectoryStep[] {
  const steps: { x: number; dt: number }[] = [];
  if (distance <= 0) return [{ x: 0, y: 0, dt: 16 }];

  let current = 0;
  let velocity = 0;
  const maxVelocity = 8;
  const accelerationPhase = distance * 0.6;

  // 第一阶段：加速
  while (current < accelerationPhase) {
    velocity = Math.min(velocity + 0.5 + rand() * 0.5, maxVelocity);
    current += velocity;
    steps.push({ x: current, dt: 16 + rand() * 8 });
  }

  // 第二阶段：减速
  while (current < distance - 5) {
    velocity = Math.max(velocity - (0.3 + rand() * 0.4), 1);
    current += velocity;
    steps.push({ x: current, dt: 16 + rand() * 12 });
  }

  // 第三阶段：微调（人类常见行为：超出后回退到位）
  current = Math.min(current, distance + 3);
  steps.push({ x: current, dt: 50 + rand() * 30 });
  steps.push({ x: distance - 1, dt: 80 + rand() * 40 });
  steps.push({ x: distance, dt: 60 + rand() * 30 });

  // 叠加手抖
  return steps.map((s) => ({
    x: Math.max(0, s.x + (rand() - 0.5) * 2),
    y: (rand() - 0.5) * 3,
    dt: s.dt,
  }));
}

export interface Point {
  x: number;
  y: number;
}

/**
 * 三次贝塞尔轨迹（用于点选逐点移动）。移植自 click-select.html 的 generateBezierPath：
 * 控制点带垂直偏移，模拟真实鼠标的弧线移动。返回 steps 个点（绝对坐标）。
 */
export function bezierPath(from: Point, to: Point, steps = 25, rand: () => number = Math.random): Point[] {
  // 两个控制点：在起点终点连线基础上做垂直偏移
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // 垂直法线方向
  const nx = -dy / dist;
  const ny = dx / dist;
  const offset1 = (rand() - 0.5) * Math.min(60, dist * 0.4);
  const offset2 = (rand() - 0.5) * Math.min(60, dist * 0.4);
  const c1: Point = {
    x: from.x + dx * 0.3 + nx * offset1,
    y: from.y + dy * 0.3 + ny * offset1,
  };
  const c2: Point = {
    x: from.x + dx * 0.7 + nx * offset2,
    y: from.y + dy * 0.7 + ny * offset2,
  };
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    pts.push({ x, y });
  }
  return pts;
}
