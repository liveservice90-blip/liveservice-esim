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
    !input ||
    typeof input.bundleName !== "string" ||
    !input.bundleName.trim() ||
    input.bundleName.length > 250
  ) {
    return reply(400, {
      error: "اختر الباقة أولًا"
    });
  }

  const key = process.env.MYFATOORAH_API_KEY?.trim();

  if (!key) {
    return reply(500, {
      error: "مفتاح ماي فاتورة غير متاح"
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

    const paymentResponse = await fetch(
      "https://api-sa.myfatoorah.com/v2/InitiatePayment",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          InvoiceAmount: bundle.salePrice,
          CurrencyIso: "SAR"
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const payment = await paymentResponse.json();

    if (
      !paymentResponse.ok ||
      payment.IsSuccess !== true ||
      !Array.isArray(payment.Data?.PaymentMethods)
    ) {
      return reply(502, {
        error: "تعذر تحميل وسائل الدفع لهذه الباقة"
      });
    }

    const methods = payment.Data.PaymentMethods
      .filter(item =>
        item.IsDirectPayment === false &&
        Number.isInteger(item.PaymentMethodId) &&
        item.CurrencyIso === "SAR" &&
        Number.isFinite(item.TotalAmount) &&
        item.TotalAmount > 0
      )
      .map(item => ({
        id: item.PaymentMethodId,
        name: item.PaymentMethodAr || item.PaymentMethodEn,
        totalAmount: item.TotalAmount,
        currency: item.CurrencyIso
      }));

    if (!methods.length) {
      return reply(502, {
        error: "لا توجد وسائل دفع متاحة لهذا المبلغ"
      });
    }

    return reply(200, {
      bundleName: bundle.name,
      description: bundle.description,
      amount: bundle.salePrice,
      currency: "SAR",
      methods,
      paymentEnabled: false,
      message: "تم تأكيد السعر وتحميل وسائل الدفع"
    });
  } catch {
    return reply(502, {
      error: "تعذر تجهيز الطلب، حاول مجددًا"
    });
  }
};
