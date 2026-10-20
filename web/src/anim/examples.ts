// Hand-written reference scripts: offline demos, the model's few-shot shape, and perf fixtures.
import { tr } from "../i18n";
import type { Action, AnimScript } from "./script.ts";

const GAP = 80;

export function bubbleSort(values: number[]): AnimScript {
  const ids = values.map((_, i) => `n${i}`);
  const order = [...ids]; // order[k] = node currently at slot k
  const val = Object.fromEntries(ids.map((id, i) => [id, values[i]]));
  const steps: AnimScript["steps"] = [];
  const step = (...actions: Action[]) => steps.push({ actions });
  step({ do: "caption", text: tr(`冒泡排序 [${values.join(", ")}]：相邻两两比较，大的往后冒`, `Bubble sort [${values.join(", ")}]: compare neighbours, the larger one bubbles right`) });
  for (let end = values.length - 1; end > 0; end--) {
    let swapped = false;
    for (let k = 0; k < end; k++) {
      const [a, b] = [order[k], order[k + 1]];
      step({ do: "unhighlight" }, { do: "highlight", ids: [a, b], color: "compare" }, { do: "caption", text: tr(`比较 ${val[a]} 和 ${val[b]}`, `Compare ${val[a]} and ${val[b]}`) });
      if (val[a] > val[b]) {
        step({ do: "swap", a, b }, { do: "highlight", ids: [a, b], color: "swap" }, { do: "caption", text: tr(`${val[a]} > ${val[b]}，交换`, `${val[a]} > ${val[b]}, swap`) });
        [order[k], order[k + 1]] = [b, a];
        swapped = true;
      }
    }
    step({ do: "unhighlight" }, { do: "highlight", ids: order.slice(end), color: "done" }, { do: "caption", text: tr(`第 ${values.length - end} 轮结束，${val[order[end]]} 就位`, `Pass ${values.length - end} done, ${val[order[end]]} is in place`) });
    if (!swapped) break;
  }
  step({ do: "highlight", ids: order, color: "done" }, { do: "caption", text: tr("排序完成", "Sorted") });
  return {
    title: tr(`冒泡排序 [${values.join(", ")}]`, `Bubble sort [${values.join(", ")}]`),
    nodes: ids.map((id, i) => ({ id, text: String(values[i]), x: i * GAP, y: 0 })),
    steps,
  };
}

export function binarySearch(values: number[], target: number): AnimScript {
  const ids = values.map((_, i) => `n${i}`);
  const steps: AnimScript["steps"] = [];
  const step = (...actions: Action[]) => steps.push({ actions });
  step({ do: "caption", text: tr(`在有序数组里二分查找 ${target}`, `Binary search for ${target} in a sorted array`) });
  let lo = 0, hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    step(
      { do: "unhighlight" },
      { do: "highlight", ids: ids.slice(lo, hi + 1).filter((_, i) => i + lo !== mid), color: "focus" },
      { do: "highlight", ids: [ids[mid]], color: "compare" },
      { do: "move", id: "mid", x: mid * GAP, y: 84 },
      { do: "caption", text: tr(`区间 [${lo}, ${hi}]，mid = ${mid}，值 ${values[mid]}`, `Range [${lo}, ${hi}], mid = ${mid}, value ${values[mid]}`) },
    );
    if (values[mid] === target) {
      step({ do: "unhighlight" }, { do: "highlight", ids: [ids[mid]], color: "done" }, { do: "set_label", id: "mid", text: tr("找到", "Found") }, { do: "caption", text: tr(`${values[mid]} = ${target}，找到了，下标 ${mid}`, `${values[mid]} = ${target}, found at index ${mid}`) });
      return { title: tr(`二分查找 ${target}`, `Binary search ${target}`), nodes: nodes(), steps };
    }
    const goRight = values[mid] < target;
    step(
      { do: "highlight", ids: goRight ? ids.slice(lo, mid + 1) : ids.slice(mid, hi + 1), color: "muted" },
      { do: "caption", text: tr(`${values[mid]} ${goRight ? "<" : ">"} ${target}，丢掉${goRight ? "左" : "右"}半边`, `${values[mid]} ${goRight ? "<" : ">"} ${target}, drop the ${goRight ? "left" : "right"} half`) },
    );
    if (goRight) lo = mid + 1;
    else hi = mid - 1;
  }
  step({ do: "unhighlight" }, { do: "caption", text: tr(`区间为空，${target} 不在数组里`, `Range is empty, ${target} isn't in the array`) });
  return { title: tr(`二分查找 ${target}`, `Binary search ${target}`), nodes: nodes(), steps };

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
  step({ do: "highlight", ids: ["a"], color: "focus" }, { do: "set_label", id: "q", text: tr("队列: A", "Queue: A") }, { do: "caption", text: tr("从 A 开始，A 入队", "Start at A, enqueue A") });
  while (queue.length) {
    const u = queue.shift()!;
    const fresh = adj[u].filter((v) => !seen.has(v));
    fresh.forEach((v) => (seen.add(v), queue.push(v)));
    step(
      { do: "highlight", ids: [u], color: "compare" },
      ...(fresh.length ? [{ do: "highlight" as const, ids: fresh, color: "focus" as const }] : []),
      { do: "set_label", id: "q", text: `${tr("队列", "Queue")}: ${queue.map((x) => x.toUpperCase()).join(" ") || tr("空", "empty")}` },
      { do: "caption", text: tr(`出队 ${u.toUpperCase()}，${fresh.length ? `发现 ${fresh.map((x) => x.toUpperCase()).join("、")}` : "没有新邻居"}`, `Dequeue ${u.toUpperCase()}, ${fresh.length ? `found ${fresh.map((x) => x.toUpperCase()).join(", ")}` : "no new neighbours"}`) },
    );
    step({ do: "highlight", ids: [u], color: "visited" }, { do: "caption", text: tr(`${u.toUpperCase()} 访问完毕`, `${u.toUpperCase()} visited`) });
  }
  step({ do: "highlight", ids: Object.keys(pos), color: "done" }, { do: "caption", text: tr("BFS 完成：A B C D E F", "BFS done: A B C D E F") });
  return {
    title: tr("BFS 遍历", "BFS traversal"),
    nodes: [
      ...Object.entries(pos).map(([id, [x, y]]) => ({ id, text: id.toUpperCase(), x, y, shape: "ellipse" as const })),
      { id: "q", text: tr("队列:", "Queue:"), x: 0, y: 340, w: 344, h: 44 },
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
    actions.push({ do: "highlight", ids, color: r % 2 ? "compare" : "focus" }, { do: "caption", text: tr(`第 ${r + 1} 轮：${n} 个元素同时移动`, `Round ${r + 1}: ${n} elements move at once`) });
    steps.push({ actions });
  }
  return { title: tr(`压力测试 ${n}`, `Stress test ${n}`), nodes: ids.map((id, i) => ({ id, text: String(i), ...at(i) })), steps };
}

export const PRESETS: { label: string; request: string; offline: () => AnimScript }[] = [
  { label: tr("冒泡排序", "Bubble sort"), request: tr("用动画演示冒泡排序 [5,3,8,1,4]", "Animate bubble sort on [5,3,8,1,4]"), offline: () => bubbleSort([5, 3, 8, 1, 4]) },
  { label: tr("二分查找", "Binary search"), request: tr("用动画演示在 [1,3,5,7,9,11,13] 里二分查找 11", "Animate a binary search for 11 in [1,3,5,7,9,11,13]"), offline: () => binarySearch([1, 3, 5, 7, 9, 11, 13], 11) },
  { label: "BFS", request: tr("用动画演示 BFS：A→B, A→C, B→D, B→E, C→F, E→F，从 A 开始", "Animate BFS: A→B, A→C, B→D, B→E, C→F, E→F, starting at A"), offline: bfs },
];
