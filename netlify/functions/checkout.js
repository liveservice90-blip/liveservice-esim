const catalogue = require("./catalogue");

exports.handler = async (event) => {
  const reply = (statusCode, data) => ({
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  });

  if (event.httpMethod !== "POST") {
    return reply(405, {
      error: "استخدم POST لاختيار الباقة"
    });
  }

  let input;

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "{}";

    input = JSON.parse(body);
  } catch {
    return reply(400, {
      error: "بيانات الطلب غير صحيحة"
    });
  }

  if (
    typeof input.bundleName !== "string" ||
    !input.bundleName.trim() ||
    input.bundleName.length > 250
  ) {
    return reply(400, {
      error: "اختر الباقة أولًا"
    });
  }

  try {
    const response = await catalogue.handler({
      httpMethod: "GET"
    });

    if (response.statusCode !== 200) {
      return reply(502, {
        error: "تعذر التحقق من سعر الباقة"
      });
    }

    const data = JSON.parse(response.body);
    const bundle = data.bundles?.find(
      item => item.name === input.bundleName
    );

    if (!bundle) {
      return reply(404, {
        error: "الباقة غير متاحة حاليًا"
      });
    }

    if (
      bundle.currency !== "SAR" ||
      typeof bundle.salePrice !== "number" ||
      !Number.isFinite(bundle.salePrice) ||
      bundle.salePrice <= 0
    ) {
      return reply(502, {
        error: "تعذر التحقق من السعر أو العملة"
      });
    }

    return reply(200, {
      bundleName: bundle.name,
      description: bundle.description,
      amount: bundle.salePrice,
      currency: "SAR",
      paymentEnabled: false,
      message: "تم التحقق من السعر؛ ربط الدفع قيد الإعداد"
    });
  } catch {
    return reply(502, {
      error: "تعذر تجهيز الطلب، حاول مجددًا"
    });
  }
};
