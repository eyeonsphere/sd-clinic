// Netlify serverless function: processes the actual Authorize.net charge.
// This runs server-side only. The Transaction Key never reaches the browser.
//
// Required environment variables (set in Netlify: Site configuration -> Environment variables):
//   AUTHNET_API_LOGIN_ID     - your Authorize.net API Login ID
//   AUTHNET_TRANSACTION_KEY  - your Authorize.net Transaction Key
//   AUTHNET_ENVIRONMENT      - "sandbox" or "production" (defaults to "sandbox" if unset)

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: "Invalid request body" }) };
  }

  const { dataDescriptor, dataValue, amount, items, customer } = payload;

  if (!dataDescriptor || !dataValue || !amount || !customer) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: "Missing required payment information." }),
    };
  }

  const API_LOGIN_ID = process.env.AUTHNET_API_LOGIN_ID;
  const TRANSACTION_KEY = process.env.AUTHNET_TRANSACTION_KEY;
  const ENVIRONMENT = process.env.AUTHNET_ENVIRONMENT || "sandbox";

  if (!API_LOGIN_ID || !TRANSACTION_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: "Payment gateway is not configured. Missing AUTHNET_API_LOGIN_ID or AUTHNET_TRANSACTION_KEY environment variables.",
      }),
    };
  }

  const apiUrl =
    ENVIRONMENT === "production"
      ? "https://api.authorize.net/xml/v1/request.api"
      : "https://apitest.authorize.net/xml/v1/request.api";

  // Build a short line-item description for the order.
  const lineItems = Array.isArray(items)
    ? items.slice(0, 30).map((it) => ({
        itemId: String(it.id || "item").slice(0, 31),
        name: String(it.name || "Item").slice(0, 31),
        description: String(it.name || "").slice(0, 255),
        quantity: String(it.qty || 1),
        unitPrice: String(it.price != null ? it.price : "0"),
      }))
    : [];

  const requestBody = {
    createTransactionRequest: {
      merchantAuthentication: {
        name: API_LOGIN_ID,
        transactionKey: TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: "authCaptureTransaction",
        amount: String(amount),
        payment: {
          opaqueData: {
            dataDescriptor: dataDescriptor,
            dataValue: dataValue,
          },
        },
        lineItems: lineItems.length ? { lineItem: lineItems } : undefined,
        order: {
          invoiceNumber: `SD-${Date.now()}`.slice(0, 20),
          description: "SD Clinic order",
        },
        customer: {
          email: customer.email,
        },
        billTo: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          address: customer.address,
          city: customer.city,
          state: customer.state,
          zip: customer.zip,
          country: "USA",
          phoneNumber: customer.phone,
        },
      },
    },
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    // Authorize.net sometimes prefixes the JSON response with a BOM character.
    const rawText = await response.text();
    const cleanText = rawText.replace(/^\uFEFF/, "");
    const result = JSON.parse(cleanText);

    const txn = result.transactionResponse;
    const overallResultCode = result.messages && result.messages.resultCode;

    if (overallResultCode === "Ok" && txn && txn.responseCode === "1") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          transactionId: txn.transId,
          authCode: txn.authCode,
        }),
      };
    }

    // Declined or errored — pull the most useful message available.
    let errorMessage = "The transaction could not be completed.";
    if (txn && txn.errors && txn.errors.length) {
      errorMessage = txn.errors.map((e) => e.errorText).join(" ");
    } else if (result.messages && result.messages.message && result.messages.message.length) {
      errorMessage = result.messages.message.map((m) => m.text).join(" ");
    } else if (txn && txn.messages && txn.messages.length) {
      errorMessage = txn.messages.map((m) => m.description).join(" ");
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: errorMessage }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: "Could not reach the payment gateway. Please try again in a moment.",
      }),
    };
  }
};
