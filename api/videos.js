// 요즘 뜨는 코디 영상: GET /api/videos?q=가을 코디
// YouTube Data API로 최근 30일 동안 올라온 영상을 조회수 순으로 가져와요.
//
// 필요한 환경변수 (Vercel → Settings → Environment Variables)
//   YOUTUBE_API_KEY : Google Cloud에서 발급한 YouTube Data API v3 키
// 투표용 Redis가 연결되어 있으면 결과를 12시간 동안 저장해서 사용량을 아껴요.

const YT_KEY = process.env.YOUTUBE_API_KEY;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// 검색할 수 있는 주제만 허용 (아무 검색어나 받으면 사용량이 금방 바닥나요)
// index.html의 영상 주제와 같은 목록이어야 해요
const BASES = [
  "한겨울 코디", "겨울 코디", "초봄 코디", "봄 코디", "늦봄 코디",
  "초여름 코디", "여름 코디", "늦여름 코디", "초가을 코디", "가을 코디", "늦가을 코디",
  "장마철 코디", "비 오는 날 코디", "눈 오는 날 코디",
  "출근룩", "데이트룩", "운동복 코디", "여행 코디"
];
const ALLOWED = new Set(BASES.flatMap(b => [b, `남자 ${b}`, `여자 ${b}`]));

const FRESH_MS = 12 * 60 * 60 * 1000;     // 12시간 지나면 새로 받아옴
const KEEP_SEC = 3 * 24 * 60 * 60;        // 새로 받기 실패 대비 최대 3일 보관 (30일 규칙보다 훨씬 짧게)

async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`Redis ${r.status}`);
  return (await r.json()).map(x => x.result);
}

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const data = await r.json();
    if (!r.ok) {
      const reason = data?.error?.errors?.[0]?.reason || r.status;
      throw new Error(`YouTube ${reason}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromYouTube(q) {
  const after = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const search = await getJSON("https://www.googleapis.com/youtube/v3/search?" + new URLSearchParams({
    part: "snippet", type: "video", q, order: "viewCount", publishedAfter: after,
    regionCode: "KR", relevanceLanguage: "ko", safeSearch: "strict", maxResults: "24", key: YT_KEY
  }));
  const ids = (search.items || []).map(i => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const detail = await getJSON("https://www.googleapis.com/youtube/v3/videos?" + new URLSearchParams({
    part: "snippet,statistics,contentDetails", id: ids.join(","), key: YT_KEY
  }));
  return (detail.items || [])
    .map(v => ({
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt,
      thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || "",
      views: Number(v.statistics?.viewCount || 0),
      duration: v.contentDetails?.duration || ""
    }))
    .sort((a, b) => b.views - a.views);
}

export default async function handler(req, res) {
  const q = String(req.query.q || "");
  if (!ALLOWED.has(q)) return res.status(400).json({ error: "지원하지 않는 주제예요." });
  if (!YT_KEY) return res.status(503).json({ error: "영상 기능이 아직 설정되지 않았어요." });

  const useCache = Boolean(REDIS_URL && REDIS_TOKEN);
  const cacheKey = `yt:${q}`;
  let cached = null;

  if (useCache) {
    try {
      const [raw] = await redis([["GET", cacheKey]]);
      cached = raw ? JSON.parse(raw) : null;
    } catch (e) { console.error(e); }
  }

  const send = (payload, stale) => {
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json({ ...payload, stale: Boolean(stale) });
  };

  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return send(cached);

  try {
    const videos = await fetchFromYouTube(q);
    const payload = { q, fetchedAt: Date.now(), videos };
    if (useCache) {
      try { await redis([["SET", cacheKey, JSON.stringify(payload), "EX", KEEP_SEC]]); } catch (e) { console.error(e); }
    }
    return send(payload);
  } catch (e) {
    console.error(e);
    // 사용량 한도 초과 등으로 실패하면 저장해 둔 결과라도 보여줌
    if (cached) return send(cached, true);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "지금은 영상을 불러올 수 없어요. 잠시 후 다시 시도해 주세요." });
  }
}
