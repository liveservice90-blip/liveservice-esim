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
    return reply(405, {
      error: "استخدم GET لعرض الباقات"
    });
  }

  const key = process.env.ESIM_GO_API_KEY?.trim();

  const profit = Number(
    process.env.PROFIT_PERCENT?.trim() || "5"
  );

  const usdToSar = Number(
    process.env.USD_TO_SAR?.trim() || "3.75"
  );

  if (!key) {
    return reply(500, {
      error: "مفتاح eSIM Go غير متاح"
    });
  }

  if (!Number.isFinite(profit) || profit < 0) {
    return reply(500, {
      error: "نسبة الربح غير صحيحة"
    });
  }

  if (!Number.isFinite(usdToSar) || usdToSar <= 0) {
    return reply(500, {
      error: "معامل تحويل الدولار إلى الريال غير صحيح"
    });
  }

  try {
    const bundles = new Map();
    const signal = AbortSignal.timeout(25000);

    for (let page = 1; page <= 100; page++) {
      const url = new URL(
        "https://api.esim-go.com/v2.5/catalogue"
      );

      url.searchParams.set("page", String(page));
      url.searchParams.set("perPage", "500");

      const response = await fetch(url, {
        headers: {
          "X-API-Key": key,
          Accept: "application/json"
        },
        signal
      });

      if (!response.ok) {
        return reply(502, {
          error: "تعذر تحميل الباقات",
          upstreamStatus: response.status
        });
      }

      const data = await response.json();

      const items = Array.isArray(data)
        ? data
        : data.bundles;

      if (!Array.isArray(items)) {
        throw new Error("Unexpected response");
      }

      if (items.length === 0) {
        return reply(200, {
          currency: "SAR",
          bundles: [...bundles.values()]
        });
      }

      let added = 0;

      for (const item of items) {
        if (
          typeof item.name !== "string" ||
          !item.name.trim()
        ) {
          throw new Error("Missing bundle name");
        }

        if (bundles.has(item.name)) {
          continue;
        }

        const rawPrice = item.price;
        const costUsd = Number(rawPrice);

        if (
          rawPrice === null ||
          rawPrice === undefined ||
          String(rawPrice).trim() === "" ||
          !Number.isFinite(costUsd) ||
          costUsd < 0
        ) {
          throw new Error("Invalid price");
        }

        // تحويل تكلفة الباقة من الدولار إلى الريال.
        const costSar = costUsd * usdToSar;

        // إضافة نسبة الربح والتقريب إلى منزلتين.
        const salePrice = Number(
          (costSar * (1 + profit / 100)).toFixed(2)
        );

        if (!Number.isFinite(salePrice)) {
          throw new Error("Invalid sale price");
        }

        bundles.set(item.name, {
          name: item.name,
          description: item.description,
          countries: Array.isArray(item.countries)
            ? item.countries
            : [],
          dataAmount: item.dataAmount,
          duration: item.duration,
          durationUnit: item.durationUnit || "day",
          unlimited: item.unlimited,
          salePrice,
          currency: "SAR"
        });

        added++;
      }

      if (added === 0) {
        throw new Error("Pagination did not advance");
      }
    }

    throw new Error("Catalogue limit reached");
  } catch {
    return reply(502, {
      error: "لم يكتمل تحميل الباقات، حاول لاحقًا"
    });
  }
};
