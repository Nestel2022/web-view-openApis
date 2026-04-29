const isNodeEnv = typeof module !== "undefined" && module.exports;
const configModule = isNodeEnv ? require("./config") : globalThis.AppConfig;
const signatureModule = isNodeEnv ? require("./signature") : globalThis.SignatureUtils;

const { ENV, getGWPConfig } = configModule;
const { signGenerator } = signatureModule;

function getMyApi() {
  if (typeof my === "undefined") {
    throw new TypeError("No se detecto objeto my del mini programa.");
  }
  return my;
}

function escapeShellValue(value) {
  const singleQuoteEscape = "'\"'\"'";
  return String(value).replaceAll("'", singleQuoteEscape);
}

function buildCurlCommand(requestConfig) {
  const method = requestConfig.method || "GET";
  const headers = requestConfig.headers || {};
  const headerFlags = Object.entries(headers)
    .map(([key, value]) => {
      const headerValue = key + ": " + value;
      return "-H '" + escapeShellValue(headerValue) + "'";
    })
    .join(" ");
  const bodyFlag = requestConfig.data === undefined
    ? ""
    : " --data-raw '" + escapeShellValue(JSON.stringify(requestConfig.data)) + "'";
  const urlValue = escapeShellValue(requestConfig.url);
  const headerSegment = headerFlags ? " " + headerFlags : "";

  return "curl -X " + method + " '" + urlValue + "'" + headerSegment + bodyFlag;
}

async function executeHttpRequest(requestConfig) {
  if (typeof fetch === "function") {
    const hasBody = requestConfig.data !== undefined;
    const headers = hasBody ? { "Content-Type": "application/json" } : {};
    Object.assign(headers, requestConfig.headers ?? {});
    const response = await fetch(requestConfig.url, {
      method: requestConfig.method || "GET",
      headers,
      body: hasBody ? JSON.stringify(requestConfig.data) : undefined,
    });
    const rawBody = await response.text();

    let data = rawBody;
    if (rawBody) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = rawBody;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data,
      rawBody,
      curl: buildCurlCommand({
        ...requestConfig,
        headers,
      }),
    };
  }

  throw new TypeError("fetch no esta disponible en este entorno.");
}

/**
 * Obtiene los tokens usando MQFetchSelfcareParameters.
 */
async function getTokens() {
  const myApi = getMyApi();
  try {
    const { result } = await myApi.call("MQFetchSelfcareParameters", {});
    return result || {};
  } catch (error) {
    console.warn("No fue posible obtener MQFetchSelfcareParameters", error);
    return {};
  }
}

/**
 * Genera el formato de firma requerido por el gateway.
 */
function generateSignatureFormat(globaldata, requestGateway, requestTimeGateway, url) {
  return {
    HTTP_METHOD: "POST",
    URL: url,
    CLIENT_ID: globaldata.clientId,
    MERCHANT_ID: globaldata.merchantId,
    REQUEST_TIME: requestTimeGateway,
    PRIVATE_KEY: globaldata.privateKey,
    reqMap: {
      ...requestGateway,
    },
  };
}

/**
 * Configura la peticion para applyToken.
 */
async function getConfigAccessToken(data) {
  const myApi = getMyApi();
  const { clientId, merchantId } = data;

  let authCode;
  try {
    const res = await myApi.getAuthCode({ scopes: ["User_Customer_Info"] });
    authCode = res.authCode;
  } catch (error) {
    console.warn("Fallo User_Customer_Info, se intentara User_Base_Info", error);
    const fallbackRes = await myApi.getAuthCode({ scopes: ["User_Base_Info"] });
    authCode = fallbackRes.authCode;
  }

  const { appId } = myApi.getAppIdSync();
  const body = {
    appId,
    grantType: "AUTHORIZATION_CODE",
    authClientId: clientId,
    authCode,
  };

  const requestTimeGateway = Math.floor(Date.now() / 1000).toString();
  const url = "/miniprogram/api/v2/authorization/applyToken";
  const signatureFormat = generateSignatureFormat(data, body, requestTimeGateway, url);
  const signature = signGenerator(signatureFormat);

  return {
    clientId,
    merchantId,
    signature,
    requestTimeGateway,
    body,
  };
}

/**
 * Solicita accessToken al endpoint applyToken.
 */
async function getAccessToken(url, dataService) {
  const data = await getConfigAccessToken(dataService);
  const headersApply = {
    "Client-Id": data.clientId,
    "Request-Time": data.requestTimeGateway,
    Signature: data.signature,
    "Merchant-id": data.merchantId,
  };

  const requestConfig = {
    url: `${url}applyToken`,
    method: "POST",
    data: data.body,
    headers: headersApply,
  };

  return executeHttpRequest(requestConfig);
}

/**
 * Configura la peticion de inquiryUserBasicInfo.
 */
async function getConfigInquiryUserInfo(url) {
  const myApi = getMyApi();
  const data = getGWPConfig(ENV);
  const responseAccessToken = await getAccessToken(url, data);
  const { clientId, merchantId } = data;
  const { appId } = myApi.getAppIdSync();

  const body = {
    appId,
    accessToken: responseAccessToken?.data?.accessToken,
    authClientId: clientId,
  };

  const requestTimeGateway = Math.floor(Date.now() / 1000).toString();
  const urlConfig = "/miniprogram/api/v2/users/inquiryUserBasicInfo";
  const signatureFormat = generateSignatureFormat(data, body, requestTimeGateway, urlConfig);
  const signature = signGenerator(signatureFormat);

  return {
    clientId,
    merchantId,
    signature,
    requestTimeGateway,
    body,
  };
}

/**
 * Consulta los datos basicos del usuario.
 */
async function getInquiryUserInfo(urlUsers, urlApplyToken, headers = {}) {
  const tokens = await getTokens();

  const extraHeaders = {
    "X-MC-DEVICE-ID": tokens.device_id || headers["X-MC-DEVICE-ID"] || "",
    "X-MC-USER-AGENT": tokens.user_agent || headers["X-MC-USER-AGENT"] || "",
  };

  const data = await getConfigInquiryUserInfo(urlApplyToken);
  const headersApply = {
    "Client-Id": data.clientId,
    "Request-Time": data.requestTimeGateway,
    Signature: data.signature,
    "Merchant-id": data.merchantId,
    ...extraHeaders,
  };

  const requestConfig = {
    url: `${urlUsers}inquiryUserBasicInfo`,
    method: "POST",
    data: data.body,
    headers: headersApply,
  };

  return executeHttpRequest(requestConfig);
}

/**
 * Recupera los headers extras necesarios para trazabilidad.
 */
function getExtraData(headers = {}) {
  return {
    "X-MC-DEVICE-ID": headers["X-MC-DEVICE-ID"] || "",
    "X-MC-USER-AGENT": headers["X-MC-USER-AGENT"] || "",
  };
}

const exportedOpenApis = {
  getInquiryUserInfo,
  getExtraData,
  getAccessToken,
  getConfigInquiryUserInfo,
  getConfigAccessToken,
  generateSignatureFormat,
  buildCurlCommand,
  executeHttpRequest,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportedOpenApis;
}

if (!isNodeEnv) {
  globalThis.OpenApis = exportedOpenApis;
}
