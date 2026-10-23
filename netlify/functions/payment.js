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

  const key = process.env.MYFATOORAH_API_KEY?.trim();

  if (!key) {
    return reply(500, {
      error: "مفتاح ماي فاتورة غير متاح"
    });
  }

  try {
    const response = await fetch(
      "https://api-sa.myfatoorah.com/v2/InitiatePayment",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          InvoiceAmount: 10,
          CurrencyIso: "SAR"
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const data = await response.json();

    if (!response.ok || !data.IsSuccess) {
      return reply(502, {
        error: "تعذر الاتصال بماي فاتورة؛ تحقق من المفتاح وصلاحياته",
        upstreamStatus: response.status
      });
    }

    const methods = data.Data?.PaymentMethods;

    if (!Array.isArray(methods)) {
      throw new Error("Unexpected response");
    }

    return reply(200, {
      message: "تم الاتصال بماي فاتورة بنجاح",
      methods: methods.map(item => ({
        id: item.PaymentMethodId,
        name: item.PaymentMethodAr,
        direct: item.IsDirectPayment
      }))
    });
  } catch {
    return reply(502, {
      error: "تعذر إكمال فحص الاتصال، حاول مجددًا"
    });
  }
};
