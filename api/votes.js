// 색 조합 추천/비추천 투표 API
// GET  /api/votes?all=1                    → 모든 조합의 투표 수 (순위용)
// GET  /api/votes?ids=navy-beige,white-denim → 일부 조합의 투표 수
// POST /api/votes  { id, dUp, dDown }        → 투표 반영 (id = "상의색-하의색")
//
// Vercel 프로젝트의 Storage 탭에서 Upstash Redis를 연결하면
// 아래 환경변수가 자동으로 들어와요. 따로 입력할 건 없어요.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// index.html의 COLORS와 같은 목록이어야 해요
const COLORS = new Set([
  "white", "black", "gray", "charcoal", "navy", "denim", "sky", "beige",
  "camel", "brown", "khaki", "green", "mustard", "burgundy", "pink"
]);

const UP = "pair:up";
const DOWN = "pair:down";
const RATE_LIMIT = 40; // IP당 1분에 투표 횟수 제한

function validId(id) {
  if (typeof id !== "string") return false;
  const parts = id.split("-");
  return parts.length === 2 && parts.every(p => COLORS.has(p));
}

// Upstash REST API로 Redis 명령 여러 개를 한 번에 실행
async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  const out = await r.json();
  return out.map(x => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

const num = v => Math.max(0, parseInt(v ?? "0", 10) || 0);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: "투표 저장소가 연결되지 않았어요." });
  }

  try {
    if (req.method === "GET" && req.query.all) {
      const [ups, downs] = await redis([["HGETALL", UP], ["HGETALL", DOWN]]);
      const counts = {};
      // HGETALL 결과는 [키, 값, 키, 값, ...] 형태
      const fill = (arr, key) => {
        for (let i = 0; i < (arr || []).length; i += 2) {
          if (!validId(arr[i])) continue;
          counts[arr[i]] ??= { up: 0, down: 0 };
          counts[arr[i]][key] = num(arr[i + 1]);
        }
      };
      fill(ups, "up");
      fill(downs, "down");
      res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
      return res.status(200).json({ counts });
    }

    if (req.method === "GET") {
      const ids = String(req.query.ids || "").split(",").filter(validId).slice(0, 20);
      if (!ids.length) return res.status(200).json({ counts: {} });
      const [ups, downs] = await redis([
        ["HMGET", UP, ...ids],
        ["HMGET", DOWN, ...ids]
      ]);
      const counts = {};
      ids.forEach((id, i) => { counts[id] = { up: num(ups[i]), down: num(downs[i]) }; });
      return res.status(200).json({ counts });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const { id, dUp, dDown } = body;
      const okDelta = d => Number.isInteger(d) && d >= -1 && d <= 1;
      if (!validId(id) || !okDelta(dUp) || !okDelta(dDown)) {
        return res.status(400).json({ error: "잘못된 투표예요." });
      }

      // 간단한 도배 방지
      const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
      const rlKey = `rl:${ip}`;
      const [, hits] = await redis([["SET", rlKey, 0, "EX", 60, "NX"], ["INCR", rlKey]]);
      if (hits > RATE_LIMIT) {
        return res.status(429).json({ error: "잠시 후 다시 시도해 주세요." });
      }

      let [up, down] = await redis([
        ["HINCRBY", UP, id, dUp],
        ["HINCRBY", DOWN, id, dDown]
      ]);
      // 0 아래로 내려가지 않게 보정
      const fix = [];
      if (up < 0) { fix.push(["HSET", UP, id, 0]); up = 0; }
      if (down < 0) { fix.push(["HSET", DOWN, id, 0]); down = 0; }
      if (fix.length) await redis(fix);

      return res.status(200).json({ count: { up, down } });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "지원하지 않는 요청이에요." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "투표 서버에 문제가 생겼어요." });
  }
}
