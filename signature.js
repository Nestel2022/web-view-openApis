const isNodeEnv = typeof module !== "undefined" && module.exports;
const jsrsasign = isNodeEnv ? require("jsrsasign") : null;
const configModule = isNodeEnv ? require("./config") : globalThis.AppConfig;
const { ENV, getGWPConfig } = configModule;

function ensurePEM(privateKey) {
  if (!privateKey) {
    throw new Error("No se recibio una clave privada para firmar.");
  }

  if (privateKey.includes("BEGIN PRIVATE KEY")) {
    return privateKey;
  }

  return `-----BEGIN PRIVATE KEY-----${privateKey}-----END PRIVATE KEY-----`;
}

/**
 * Genera una firma digital para encabezado HTTP con RSA SHA-256.
 */
function signGenerator(data) {
  const envConfig = getGWPConfig(ENV);
  const {
    HTTP_METHOD,
    URL,
    REQUEST_TIME,
    MERCHANT_ID = envConfig.merchantId,
    PRIVATE_KEY = envConfig.privateKey,
    CLIENT_ID = envConfig.clientId,
    reqMap,
  } = data;

  const mapJson = JSON.stringify(reqMap || {});
  const content = `${HTTP_METHOD} ${URL}\n${CLIENT_ID}.${MERCHANT_ID}.${REQUEST_TIME}.${mapJson}`;
  const signed = signContent(content, ensurePEM(PRIVATE_KEY));

  return `algorithm=RSA256, keyVersion=0, signature=${signed}`;
}

/**
 * Firma un contenido con clave RSA privada en formato PEM.
 */
function signContent(content, privateKeyPem) {
  const privateKey = isNodeEnv
    ? jsrsasign.KEYUTIL.getKey(privateKeyPem)
    : KEYUTIL.getKey(privateKeyPem);
  const sig = isNodeEnv
    ? new jsrsasign.crypto.Signature({ alg: "SHA256withRSA" })
    : new KJUR.crypto.Signature({ alg: "SHA256withRSA" });

  sig.init(privateKey);
  sig.updateString(content);

  const signature = sig.sign();
  return isNodeEnv ? jsrsasign.hextob64(signature) : hextob64(signature);
}

const exportedSignatureUtils = {
  signGenerator,
  signContent,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportedSignatureUtils;
}

if (!isNodeEnv) {
  globalThis.SignatureUtils = exportedSignatureUtils;
}
