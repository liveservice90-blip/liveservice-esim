exports.handler = async (event) => {
  const reply = (statusCode, data) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== "GET") {
    return reply(405, { error: "GET only" });
  }

  const key = process.env.ESIM_GO_API_KEY;

  if (!key) {
    return reply(500, {
      error: "مفتاح eSIM Go غير متاح للدالة"
    });
  }

  try {
    const response = await fetch(
      "https://api.esim-go.com/v2.5/catalogue",
      {
        headers: {
          "X-API-Key": key,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      return reply(502, {
        error: "تعذر جلب الباقات من eSIM Go",
        upstreamStatus: response.status
      });
    }

    const data = await response.json();
    return reply(200, data);
  } catch {
    return reply(502, {
      error: "تعذر الاتصال بخدمة الباقات"
    });
  }
};
