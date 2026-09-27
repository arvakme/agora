// Hand-written reference scripts: offline demos, the model's few-shot shape, and perf fixtures.
import type { Action, AnimScript } from "./script.ts";

const GAP = 80;

export function bubbleSort(values: number[]): AnimScript {
  const ids = values.map((_, i) => `n${i}`);
  const order = [...ids]; // order[k] = node currently at slot k
  const val = Object.fromEntries(ids.map((id, i) => [id, values[i]]));
  const steps: AnimScript["steps"] = [];
  const step = (...actions: Action[]) => steps.push({ actions });
  step({ do: "caption", text: `冒泡排序 [${values.join(", ")}]：相邻两两比较，大的往后冒` });
  for (let end = values.length - 1; end > 0; end--) {
    let swapped = false;
    for (let k = 0; k < end; k++) {
      const [a, b] = [order[k], order[k + 1]];
      step({ do: "unhighlight" }, { do: "highlight", ids: [a, b], color: "compare" }, { do: "caption", text: `比较 ${val[a]} 和 ${val[b]}` });
      if (val[a] > val[b]) {
        step({ do: "swap", a, b }, { do: "highlight", ids: [a, b], color: "swap" }, { do: "caption", text: `${val[a]} > ${val[b]}，交换` });
        [order[k], order[k + 1]] = [b, a];
        swapped = true;
      }
    }
    step({ do: "unhighlight" }, { do: "highlight", ids: order.slice(end), color: "done" }, { do: "caption", text: `第 ${values.length - end} 轮结束，${val[order[end]]} 就位` });
    if (!swapped) break;
  }
  step({ do: "highlight", ids: order, color: "done" }, { do: "caption", text: "排序完成" });
  return {
    title: `冒泡排序 [${values.join(", ")}]`,
    nodes: ids.map((id, i) => ({ id, text: String(values[i]), x: i * GAP, y: 0 })),
    steps,
  };
}

export function binarySearch(values: number[], target: number): AnimScript {
  const ids = values.map((_, i) => `n${i}`);
  const steps: AnimScript["steps"] = [];
  const step = (...actions: Action[]) => steps.push({ actions });
  step({ do: "caption", text: `在有序数组里二分查找 ${target}` });
  let lo = 0, hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    step(
      { do: "unhighlight" },
      { do: "highlight", ids: ids.slice(lo, hi + 1).filter((_, i) => i + lo !== mid), color: "focus" },
      { do: "highlight", ids: [ids[mid]], color: "compare" },
      { do: "move", id: "mid", x: mid * GAP, y: 84 },
      { do: "caption", text: `区间 [${lo}, ${hi}]，mid = ${mid}，值 ${values[mid]}` },
    );
    if (values[mid] === target) {
      step({ do: "unhighlight" }, { do: "highlight", ids: [ids[mid]], color: "done" }, { do: "set_label", id: "mid", text: "找到" }, { do: "caption", text: `${values[mid]} = ${target}，找到了，下标 ${mid}` });
      return { title: `二分查找 ${target}`, nodes: nodes(), steps };
    }
    const goRight = values[mid] < target;
    step(
      { do: "highlight", ids: goRight ? ids.slice(lo, mid + 1) : ids.slice(mid, hi + 1), color: "muted" },
      { do: "caption", text: `${values[mid]} ${goRight ? "<" : ">"} ${target}，丢掉${goRight ? "左" : "右"}半边` },
    );
    if (goRight) lo = mid + 1;
    else hi = mid - 1;
  }
  step({ do: "unhighlight" }, { do: "caption", text: `区间为空，${target} 不在数组里` });
  return { title: `二分查找 ${target}`, nodes: nodes(), steps };

  function nodes() {
    return [
      ...values.map((v, i) => ({ id: ids[i], text: String(v), x: i * GAP, y: 0 })),
      { id: "mid", text: "mid", x: 0, y: 84, h: 32, shape: "ellipse" as const },
    ];
  }
}

export function bfs(): AnimScript {
  const pos: Record<string, [number, number]> = { a: [160, 0], b: [40, 120], c: [280, 120], d: [0, 240], e: [120, 240], f: [280, 240] };
  const adj: Record<string, string[]> = { a: ["b", "c"], b: ["d", "e"], c: ["f"], d: [], e: ["f"], f: [] };
  const steps: AnimScript["steps"] = [];
  const step = (...actions: Action[]) => steps.push({ actions });
  const seen = new Set(["a"]);
  const queue = ["a"];
  step({ do: "highlight", ids: ["a"], color: "focus" }, { do: "set_label", id: "q", text: "队列: A" }, { do: "caption", text: "从 A 开始，A 入队" });
  while (queue.length) {
    const u = queue.shift()!;
    const fresh = adj[u].filter((v) => !seen.has(v));
    fresh.forEach((v) => (seen.add(v), queue.push(v)));
    step(
      { do: "highlight", ids: [u], color: "compare" },
      ...(fresh.length ? [{ do: "highlight" as const, ids: fresh, color: "focus" as const }] : []),
      { do: "set_label", id: "q", text: `队列: ${queue.map((x) => x.toUpperCase()).join(" ") || "空"}` },
      { do: "caption", text: `出队 ${u.toUpperCase()}，${fresh.length ? `发现 ${fresh.map((x) => x.toUpperCase()).join("、")}` : "没有新邻居"}` },
    );
    step({ do: "highlight", ids: [u], color: "visited" }, { do: "caption", text: `${u.toUpperCase()} 访问完毕` });
  }
  step({ do: "highlight", ids: Object.keys(pos), color: "done" }, { do: "caption", text: "BFS 完成：A B C D E F" });
  return {
    title: "BFS 遍历",
    nodes: [
      ...Object.entries(pos).map(([id, [x, y]]) => ({ id, text: id.toUpperCase(), x, y, shape: "ellipse" as const })),
      { id: "q", text: "队列:", x: 0, y: 340, w: 344, h: 44 },
    ],
    edges: Object.entries(adj).flatMap(([from, tos]) => tos.map((to) => ({ from, to }))),
    steps,
  };
}

/** Perf fixture: n nodes on a grid; every step reverses the whole grid and recolours it. */
export function stress(n: number, rounds = 6): AnimScript {
  const cols = Math.ceil(Math.sqrt(n * 2));
  const at = (k: number) => ({ x: (k % cols) * GAP, y: Math.floor(k / cols) * GAP });
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  const steps: AnimScript["steps"] = [];
  for (let r = 0; r < rounds; r++) {
    const actions: Action[] = ids.map((id, i) => ({ do: "move", id, ...at(r % 2 ? i : n - 1 - i) }));
    actions.push({ do: "highlight", ids, color: r % 2 ? "compare" : "focus" }, { do: "caption", text: `第 ${r + 1} 轮：${n} 个元素同时移动` });
    steps.push({ actions });
  }
  return { title: `压力测试 ${n}`, nodes: ids.map((id, i) => ({ id, text: String(i), ...at(i) })), steps };
}

export const PRESETS: { label: string; request: string; offline: () => AnimScript }[] = [
  { label: "冒泡排序", request: "用动画演示冒泡排序 [5,3,8,1,4]", offline: () => bubbleSort([5, 3, 8, 1, 4]) },
  { label: "二分查找", request: "用动画演示在 [1,3,5,7,9,11,13] 里二分查找 11", offline: () => binarySearch([1, 3, 5, 7, 9, 11, 13], 11) },
  { label: "BFS", request: "用动画演示 BFS：A→B, A→C, B→D, B→E, C→F, E→F，从 A 开始", offline: bfs },
];
