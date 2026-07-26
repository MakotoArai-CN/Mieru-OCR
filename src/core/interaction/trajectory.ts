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

/** 拖拽速度档位：影响轨迹时长 / 抖动幅度 / 过冲量。规则可通过 SiteRule.dragProfile 指定。 */
export type DragProfile = 'fast' | 'normal' | 'cautious';

interface ProfileParams {
  maxVelocity: number;
  accelBase: number;
  accelRand: number;
  decelBase: number;
  decelRand: number;
  jitterX: number;
  jitterY: number;
  overshoot: number;
  dtBase: number;
  dtRand: number;
}

function profileParams(profile: DragProfile): ProfileParams {
  switch (profile) {
    case 'fast':
      return { maxVelocity: 12, accelBase: 0.8, accelRand: 0.7, decelBase: 0.5, decelRand: 0.5, jitterX: 1.5, jitterY: 2, overshoot: 2, dtBase: 12, dtRand: 6 };
    case 'cautious':
      return { maxVelocity: 5, accelBase: 0.35, accelRand: 0.35, decelBase: 0.2, decelRand: 0.3, jitterX: 2.5, jitterY: 4, overshoot: 6, dtBase: 22, dtRand: 16 };
    case 'normal':
    default:
      return { maxVelocity: 8, accelBase: 0.5, accelRand: 0.5, decelBase: 0.3, decelRand: 0.4, jitterX: 2, jitterY: 3, overshoot: 3, dtBase: 16, dtRand: 10 };
  }
}

/**
 * 生成到目标距离 distance 的拖拽轨迹（加速 → 减速 → 过冲回拉微调 + 手抖）。
 * @param distance 目标水平位移（px）
 * @param opts.profile 速度档位（默认 'normal'）；opts.rand 可注入随机源便于测试复现。
 */
export function humanDragTrajectory(
  distance: number,
  opts: { profile?: DragProfile; rand?: () => number } = {},
): TrajectoryStep[] {
  const rand = opts.rand ?? Math.random;
  const p = profileParams(opts.profile ?? 'normal');
  if (distance <= 0) return [{ x: 0, y: 0, dt: 16 }];

  const steps: { x: number; dt: number }[] = [];
  let current = 0;
  let velocity = 0;
  const accelerationPhase = distance * 0.6;

  // 第一阶段：加速
  while (current < accelerationPhase) {
    velocity = Math.min(velocity + p.accelBase + rand() * p.accelRand, p.maxVelocity);
    current += velocity;
    steps.push({ x: current, dt: p.dtBase + rand() * p.dtRand });
  }

  // 第二阶段：减速
  while (current < distance - 5) {
    velocity = Math.max(velocity - (p.decelBase + rand() * p.decelRand), 1);
    current += velocity;
    steps.push({ x: current, dt: p.dtBase + rand() * (p.dtRand + 2) });
  }

  // 第三阶段：过冲后回拉到位（人类常见行为），过冲幅度随档位变化
  const over = distance + p.overshoot * (0.5 + rand() * 0.8);
  steps.push({ x: over, dt: 40 + rand() * 30 });
  steps.push({ x: distance + 1, dt: 60 + rand() * 30 });
  steps.push({ x: distance - 1, dt: 70 + rand() * 40 });
  steps.push({ x: distance, dt: 50 + rand() * 30 });

  // 叠加手抖（幅度按档位）
  return steps.map((s) => ({
    x: Math.max(0, s.x + (rand() - 0.5) * p.jitterX),
    y: (rand() - 0.5) * p.jitterY,
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
