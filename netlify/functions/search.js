// netlify/functions/search.js
// Autocomplete de tickers con nombre y logo (via Finnhub)

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = "https://finnhub.io/api/v1";

exports.handler = async (event) => {
  const q = (event.queryStringParameters && event.queryStringParameters.q || "").trim();

  if (!q) {
    return { statusCode: 200, body: JSON.stringify([]) };
  }

  try {
    const searchRes = await fetch(
      `${FINNHUB_BASE}/search?q=${encodeURIComponent(q)}&token=${FINNHUB_API_KEY}`
    );
    const searchData = await searchRes.json();

    const candidates = (searchData.result || [])
      .filter((item) => item.type === "Common Stock" || item.type === "ADR")
      .slice(0, 8);

    // Trae el logo de cada candidato en paralelo
    const results = await Promise.all(
      candidates.map(async (item) => {
        let logo = "";
        try {
          const profRes = await fetch(
            `${FINNHUB_BASE}/stock/profile2?symbol=${item.symbol}&token=${FINNHUB_API_KEY}`
          );
          const profData = await profRes.json();
          logo = profData.logo || "";
        } catch (e) {
          logo = "";
        }
        return {
          symbol: item.symbol,
          name: item.description,
          logo,
        };
      })
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
