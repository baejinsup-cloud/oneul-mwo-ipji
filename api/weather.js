// 날씨 중계 API: GET /api/weather?lat=37.57&lon=126.98
// 브라우저에서 Open-Meteo를 직접 부르지 못할 때(회사망 차단, 광고 차단기 등)
// 이 서버가 대신 받아서 넘겨줘요. 같은 지역은 10분 동안 캐시해요.

const FIELDS =
  "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
  "&hourly=temperature_2m,apparent_temperature,weather_code,precipitation_probability,wind_speed_10m" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max" +
  "&timezone=Asia%2FSeoul&forecast_days=2";

export default async function handler(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: "위치 값이 올바르지 않아요." });
  }

  // 소수점 둘째 자리로 맞춰서 비슷한 위치끼리 캐시를 공유
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}${FIELDS}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const data = await r.json();
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "날씨 서버에서 정보를 받지 못했어요." });
  }
}
