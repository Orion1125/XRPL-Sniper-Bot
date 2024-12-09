require("dotenv").config();
const xrpl = require("xrpl");

// Load configuration from .env
const XRPL_WSS_URL = process.env.XRPL_WSS_URL;
const PRIVATE_KEY = process.env.XRPL_PRIVATE_KEY;
const STATIC_FEE = parseFloat(process.env.STATIC_FEE);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS);
const MARKET_CAP_THRESHOLD = parseInt(process.env.MARKET_CAP_THRESHOLD);

// Connect to XRPL client
const client = new xrpl.Client(XRPL_WSS_URL);

async function isBlackholed(client, issuer) {
  const accountInfo = await client.request({
    command: "account_info",
    account: issuer,
    ledger_index: "validated",
  });

  return (
    accountInfo.result.account_data.RegularKey === null &&
    accountInfo.result.account_data.flags & xrpl.AccountFlags.lsfDisableMaster
  );
}

async function getTokenLiquidity(client, issuer, currency) {
  const bookOffers = await client.request({
    command: "book_offers",
    taker_gets: { currency: "XRP" },
    taker_pays: { currency, issuer },
    ledger_index: "validated",
  });

  let totalLiquidity = 0;
  let creatorControl = false;

  const offers = bookOffers.result.offers || [];
  offers.forEach((offer) => {
    totalLiquidity += parseFloat(offer.TakerPays.value || 0);

    if (offer.Account === issuer) {
      console.log(
        'Issuer ${issuer} has direct control of liquidity in the pool. Skipping token ${currency}.'
      );
      creatorControl = true;
    }
  });

  if (creatorControl) return 0;

  console.log(
    Total accessible liquidity for token ${currency}: ${totalLiquidity}
  );
  return totalLiquidity;
}

async function getMarketCap(client, issuer, currency) {
  const accountLines = await client.request({
    command: "account_lines",
    account: issuer,
    ledger_index: "validated",
  });

  const trustLine = accountLines.result.lines.find(
    (line) => line.currency === currency
  );

  if (!trustLine) return 0;

  const supply = parseFloat(trustLine.balance);
  return supply;
}

async function snipeToken(client, wallet, issuer, currency) {
  const transaction = {
    TransactionType: "Payment",
    Account: wallet.address,
    Amount: xrpl.xrpToDrops(STATIC_FEE),
    Destination: issuer,
    SendMax: {
      currency: currency,
      issuer: issuer,
      value: STATIC_FEE.toString(),
    },
  };

  const preparedTx = await client.autofill(transaction);
  const signedTx = wallet.sign(preparedTx);
  const result = await client.submitAndWait(signedTx.tx_blob);

  console.log(Sniped token ${currency} successfully! Transaction: ${result.result.hash});
}

async function processToken(client, wallet, issuer, currency) {
  console.log(Processing token: ${currency} issued by ${issuer});

  const blackholed = await isBlackholed(client, issuer);
  if (!blackholed) {
    console.log(Token ${currency} is not blackholed. Skipping...);
    return;
  }

  const liquidity = await getTokenLiquidity(client, issuer, currency);
  if (liquidity <= 0) {
    console.log(Token ${currency} has unsafe liquidity. Skipping...);
    return;
  }

  const marketCap = await getMarketCap(client, issuer, currency);
  if (marketCap >= MARKET_CAP_THRESHOLD) {
    console.log(Token ${currency} exceeds market cap threshold. Skipping...);
    return;
  }

  await snipeToken(client, wallet, issuer, currency);
}

async function scanNewTokens(client, wallet) {
  const accountObjects = await client.request({
    command: "ledger_data",
    ledger_index: "validated",
    type: "state",
  });

  const tokens = accountObjects.result.state.filter(
    (entry) =>
      entry.LedgerEntryType === "AccountRoot" &&
      entry.Flags & xrpl.AccountFlags.lsfDisallowXRP
  );

  const promises = tokens.map((token) =>
    processToken(client, wallet, token.Account, token.currency)
  );

  await Promise.allSettled(promises);
}

(async () => {
  await client.connect();

  const wallet = xrpl.Wallet.fromSeed(PRIVATE_KEY);

  console.log("Bot connected. Scanning for new tokens...");

  setInterval(async () => {
    try {
      await scanNewTokens(client, wallet);
    } catch (error) {
      console.error("Error scanning tokens:", error);
    }
  }, SCAN_INTERVAL_MS);
})();
