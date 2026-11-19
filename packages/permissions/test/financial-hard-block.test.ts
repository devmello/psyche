import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker, origin } from "./helpers.ts";

/**
 * The hard block on trades, bank-to-bank transfers, P2P sends and crypto sends
 * (`prohibition:financial_transfer`): terminal on every path, whatever the policy and whatever the
 * owner approved. Two lists, as for every classifier here: what must be refused, and the
 * near-misses (checkouts, bills, reading, look-alike hosts) that must still reach the Pay card.
 */

const app = (value: string) => ({ kind: "app" as const, value });

interface Row {
  name: string;
  tool: string;
  sideEffect?: "financial" | "write" | "read";
  target?: ReturnType<typeof origin> | ReturnType<typeof app>;
  meta?: Record<string, unknown>;
}

const browser = (
  host: string,
  label: string,
  more: Record<string, unknown> = {},
  tool = "browser.click",
): Row => ({
  name: `${host}: ${label}`,
  tool,
  sideEffect: "financial",
  target: origin(`https://${host}`),
  meta: { action: "click", control: { labels: [label], role: "button", ...more } },
});

const computer = (bundle: string, label: string, more: Record<string, unknown> = {}): Row => ({
  name: `${bundle}: ${label}`,
  tool: "computer.act",
  sideEffect: "financial",
  target: app(bundle),
  meta: { app: bundle, action: "click", control: { labels: [label], ...more } },
});

const MUST_BLOCK: Row[] = [
  // tools
  { name: "tool bank.transfer", tool: "bank.transfer", sideEffect: "financial" },
  { name: "tool broker.trade", tool: "broker.trade", sideEffect: "financial" },
  { name: "tool buy_stock", tool: "trading.buy_stock", sideEffect: "financial" },
  { name: "tool sellShares", tool: "sellShares", sideEffect: "financial" },
  { name: "tool place_stock_order", tool: "acme.place_stock_order", sideEffect: "financial" },
  { name: "tool send_bitcoin", tool: "wallet_tools.send_bitcoin", sideEffect: "financial" },
  { name: "tool swap tokens", tool: "defi.swap_tokens", sideEffect: "financial" },
  // MCP
  { name: "mcp alpaca submitOrder", tool: "mcp__alpaca__submitOrder", sideEffect: "write" },
  {
    name: "mcp interactive-brokers",
    tool: "mcp__interactive-brokers__place_order",
    sideEffect: "write",
  },
  { name: "mcp coinbase", tool: "mcp__coinbase__createTrade", sideEffect: "write" },
  { name: "mcp zelle", tool: "mcp__zelle__send-payment", sideEffect: "write" },
  { name: "mcp wire", tool: "mcp__bank__wire-transfer", sideEffect: "write" },
  { name: "mcp unlisted: buy_shares", tool: "mcp__acme__buy_shares", sideEffect: "write" },
  { name: "mcp unlisted: send money", tool: "mcp__acme__send_money", sideEffect: "write" },
  { name: "mcp cash app", tool: "mcp__cash_app__pay", sideEffect: "write" },
  // browser
  browser("robinhood.com", "Buy"),
  browser("www.robinhood.com", "Place order"),
  browser("client.schwab.com", "Submit order"),
  browser("www.coinbase.com", "Send"),
  browser("secure.chase.com", "Transfer money"),
  browser("www.bankofamerica.com", "Transfer"),
  browser("venmo.com", "Pay"),
  browser("www.paypal.com", "Send Money"),
  browser("www.ally.com", "Continue", {
    submits: true,
    formMethod: "post",
    formAction: "https://www.ally.com/api/transfers/submit",
  }),
  browser("secure.chase.com", "Confirm", {
    pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfers/confirm",
  }),
  browser("www.smbc.co.jp", "送金する"),
  browser("www.commerzbank.de", "Überweisung"),
  browser("www.bbva.es", "Transferir"),
  browser("www.upbit.com", "매수"),
  browser("app.unlisted-broker.example", "Buy stock"),
  browser("www.kraken.com", "", { unreadable: true }, "browser.click"),
  browser("www.coinbase.com", "", { unreadable: true }, "browser.press"),
  // computer use
  computer("com.robinhood.macos", "Buy"),
  computer("com.coinbase.desktop", "Withdraw"),
  computer("com.chase.mobile", "Transfer"),
  computer("io.metamask.desktop", "Send"),
  // review round 1 (#1321): drag, chords, Enter in a field, icon-only controls
  {
    name: "browser.drag from Buy to itself (a click)",
    tool: "browser.drag",
    sideEffect: "write",
    target: origin("https://robinhood.com"),
    meta: { control: { labels: ["Buy"], alsoLabels: ["Buy"], role: "button" } },
  },
  {
    name: "browser.drag onto Buy",
    tool: "browser.drag",
    sideEffect: "write",
    target: origin("https://robinhood.com"),
    meta: { control: { labels: ["Chart"], alsoLabels: ["Buy"], role: "button" } },
  },
  {
    name: "browser.drag by point on a bank",
    tool: "browser.drag",
    sideEffect: "write",
    target: origin("https://secure.chase.com"),
    meta: { control: { unreadable: true } },
  },
  browser("secure.chase.com", "", { unreadable: true }, "browser.press"),
  browser("robinhood.com", "", { submits: true, role: "button" }),
  browser(
    "www.venmo.com",
    "Amount",
    {
      role: "textbox",
      submits: true,
      unreadable: true,
    },
    "browser.type",
  ),
  browser("www.coinbase.com", "Buy", { role: "link", href: "javascript:void(0)" }),
  browser("secure.chase.com", "Buy"),
  browser("secure.chase.com", "Place order"),
  browser("www.sofi.com", "Buy"),
  browser("live.invest.ally.com", "Sell"),
  browser("app.revolut.com", "Buy"),
  browser("banking.ing.de", "Kaufen"),
  browser("cash.app", "Buy"),
  browser("cash.app", "Cash Out"),
  browser("www.paypal.com", "Buy", { pageUrl: "https://www.paypal.com/myaccount/crypto/buy" }),
  browser("robinhood.com", "Invest"),
  browser("robinhood.com", "Close position"),
  browser("www.wealthfront.com", "Invest now"),
  browser("www.commerzbank.de", "Bestätigen", {
    pageUrl: "https://www.commerzbank.de/ueberweisung",
  }),
  browser("www.bbva.es", "Confirmar", {
    pageUrl: "https://www.bbva.es/transferencias/confirmar",
  }),
  browser("www.degiro.com", "Passer l'ordre"),
  browser("bitflyer.com", "購入する"),
  browser("www.binance.com", "立即购买"),
  browser("www.upbit.com", "보내기"),
  browser("www.hdfcbank.com", "पैसे भेजें"),
  browser("www.hsbc.com", "أرسل"),
  browser("www.revolut.com", "Отправить"),
  browser("nubank.com.br", "Pix"),
  browser("secure.chase.com", "Trans\u00adfer"),
  browser("venmo.com", "P\u200bay"),
  {
    name: "MetaMask extension: Confirm",
    tool: "browser.click",
    sideEffect: "financial",
    target: origin("chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn"),
    meta: { action: "click", control: { labels: ["Confirm"], role: "button" } },
  },
  browser("olui2.fs.ml.com", "Buy"),
  browser("trade.thinkorswim.com", "Buy"),
  browser("www.zelle.com", "Send"),
  browser("transferwise.com", "Send"),
  // MCP and tool names that main blocked through place_order and submit_order pairs
  {
    name: "mcp robinhood-mcp place_order",
    tool: "mcp__robinhood-mcp__place_order",
    sideEffect: "write",
  },
  { name: "mcp ibkr-tws placeOrder", tool: "mcp__ibkr-tws__placeOrder", sideEffect: "write" },
  {
    name: "mcp alpaca-mcp-server",
    tool: "mcp__alpaca-mcp-server__place_order",
    sideEffect: "write",
  },
  { name: "mcp ib place_order", tool: "mcp__ib__place_order", sideEffect: "write" },
  { name: "mcp schwab-api place_order", tool: "mcp__schwab-api__place_order", sideEffect: "write" },
  { name: "mcp mybroker submit_order", tool: "mcp__mybroker__submit_order", sideEffect: "write" },
  { name: "mcp tastytrade-mcp", tool: "mcp__tastytrade-mcp__submit_order", sideEffect: "write" },
  { name: "mcp polymarket place_order", tool: "mcp__polymarket__place_order", sideEffect: "write" },
  { name: "mcp ccxt create_order", tool: "mcp__ccxt__create_order", sideEffect: "write" },
  { name: "mcp evm send_transaction", tool: "mcp__evm__send_transaction", sideEffect: "write" },
  { name: "mcp solana sendTransaction", tool: "mcp__solana__sendTransaction", sideEffect: "write" },
  { name: "mcp metamask-mcp send", tool: "mcp__metamask-mcp__send", sideEffect: "write" },
  { name: "mcp venmo-mcp pay_user", tool: "mcp__venmo-mcp__pay_user", sideEffect: "write" },
  { name: "mcp mercury create_ach", tool: "mcp__mercury__create_ach", sideEffect: "write" },
  {
    name: "mcp plaid payment_initiation_create",
    tool: "mcp__plaid__payment_initiation_create",
    sideEffect: "write",
  },
  // review round 2 (#1321): browser rows at the broker
  browser("myaccounts.capitalone.com", "Confirm", {
    pageUrl: "https://myaccounts.capitalone.com/accounts/transfer-money",
  }),
  browser("secure.chase.com", "Confirm", {
    pageUrl: "https://secure.chase.com/payments/transfer-funds/review",
  }),
  browser("secure.chase.com", "Confirm", { pageTitle: "Chase | Transfer money" }),
  browser("client.schwab.com", "Place", { pageUrl: "https://client.schwab.com/app/trade-ticket" }),
  browser("upbit.com", "인증 후 출금"),
  browser("www.smbc.co.jp", "認証して振込"),
  browser(
    "account.venmo.com",
    "What's it for?",
    {
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://account.venmo.com/pay",
      pageUrl: "https://account.venmo.com/pay",
    },
    "browser.press",
  ),
  browser("robinhood.com", "Buy options"),
  browser("robinhood.com", "Sell options"),
  browser("robinhood.com", "Order 10 AAPL shares"),
  browser("robinhood.com", "", { role: "generic" }),
  browser("robinhood.com", "→", { role: "button" }),
  browser("robinhood.com", "Buy", { role: "tab", submits: true }),
  browser("robinhood.com", "Bu\u0307y"),
  browser("robinhood.com", "Buy\uFE0F"),
  browser("secure.chase.com", "Trans\u3164fer"),
  // review round 2 (#1321): the reviewer's tool-name probe list
  {
    name: "round 2: mcp__kalshi__create_order",
    tool: "mcp__kalshi__create_order",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__my_ib_tools__order",
    tool: "mcp__my_ib_tools__order",
    sideEffect: "write",
  },
  { name: "round 2: mcp__alpaca__fetch", tool: "mcp__alpaca__fetch", sideEffect: "write" },
  { name: "round 2: mcp__alpaca__query", tool: "mcp__alpaca__query", sideEffect: "write" },
  {
    name: "round 2: mcp__ccxt__fetch_and_create_order",
    tool: "mcp__ccxt__fetch_and_create_order",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__robinhood__check_out",
    tool: "mcp__robinhood__check_out",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__coinbase__preview_and_execute",
    tool: "mcp__coinbase__preview_and_execute",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__ibkr__status_then_submit",
    tool: "mcp__ibkr__status_then_submit",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__webull__get_or_place_order",
    tool: "mcp__webull__get_or_place_order",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__alpaca__estimate_and_buy",
    tool: "mcp__alpaca__estimate_and_buy",
    sideEffect: "write",
  },
  { name: "round 2: mcp__ccxt__request", tool: "mcp__ccxt__request", sideEffect: "write" },
  {
    name: "round 2: mcp__robinhood__execute",
    tool: "mcp__robinhood__execute",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__binance__new_order",
    tool: "mcp__binance__new_order",
    sideEffect: "write",
  },
  { name: "round 2: mcp__kraken__add_order", tool: "mcp__kraken__add_order", sideEffect: "write" },
  {
    name: "round 2: mcp__alpaca__liquidate_all",
    tool: "mcp__alpaca__liquidate_all",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__hyperliquid__open_position",
    tool: "mcp__hyperliquid__open_position",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__uniswap__exactInputSingle",
    tool: "mcp__uniswap__exactInputSingle",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__wallet__sign_typed_data",
    tool: "mcp__wallet__sign_typed_data",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__evm__write_contract",
    tool: "mcp__evm__write_contract",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__evm__call_contract_function",
    tool: "mcp__evm__call_contract_function",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__solana__transfer_sol",
    tool: "mcp__solana__transfer_sol",
    sideEffect: "write",
  },
  { name: "round 2: mcp__base__send_eth", tool: "mcp__base__send_eth", sideEffect: "write" },
  {
    name: "round 2: mcp__goat__approve_token",
    tool: "mcp__goat__approve_token",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__stripe__create_transfer",
    tool: "mcp__stripe__create_transfer",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__wise__create_quote_and_fund",
    tool: "mcp__wise__create_quote_and_fund",
    sideEffect: "write",
  },
  { name: "round 2: mcp__revolut__pay", tool: "mcp__revolut__pay", sideEffect: "write" },
  { name: "round 2: mcp__chase__pay", tool: "mcp__chase__pay", sideEffect: "write" },
  // review round 3 (#1321): the reviewer's tool-name probe list
  {
    name: "round 3: mcp__coinbase-agentkit__execute",
    tool: "mcp__coinbase-agentkit__execute",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__wallet__sign_and_send",
    tool: "mcp__wallet__sign_and_send",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__binance-mcp__new_order",
    tool: "mcp__binance-mcp__new_order",
    sideEffect: "write",
  },
  { name: "round 3: mcp__ccxt__createOrder", tool: "mcp__ccxt__createOrder", sideEffect: "write" },
  { name: "round 3: mcp__webull-mcp__buy", tool: "mcp__webull-mcp__buy", sideEffect: "write" },
  {
    name: "round 3: mcp__alpaca__close_position",
    tool: "mcp__alpaca__close_position",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__robinhood__liquidate",
    tool: "mcp__robinhood__liquidate",
    sideEffect: "write",
  },
  { name: "round 3: mcp__cashapp__pay", tool: "mcp__cashapp__pay", sideEffect: "write" },
  { name: "round 3: mcp__venmo__pay", tool: "mcp__venmo__pay", sideEffect: "write" },
  { name: "round 3: mcp__bank__ach", tool: "mcp__bank__ach", sideEffect: "write" },
  {
    name: "round 3: mcp__stripe__create_payout",
    tool: "mcp__stripe__create_payout",
    sideEffect: "write",
  },
  { name: "round 3: mcp__zelle-mcp__send", tool: "mcp__zelle-mcp__send", sideEffect: "write" },
  { name: "round 3: mcp__brokerage__buy", tool: "mcp__brokerage__buy", sideEffect: "write" },
  { name: "round 3: mcp__acme__buy_eth", tool: "mcp__acme__buy_eth", sideEffect: "write" },
  {
    name: "round 3: mcp__event-trading__place_order",
    tool: "mcp__event-trading__place_order",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__sports-trading__place_bet",
    tool: "mcp__sports-trading__place_bet",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__trading-bot__execute",
    tool: "mcp__trading-bot__execute",
    sideEffect: "write",
  },
  { name: "round 3: mcp__mybroker__execute", tool: "mcp__mybroker__execute", sideEffect: "write" },
  { name: "round 3: mcp__alpaca__get", tool: "mcp__alpaca__get", sideEffect: "write" },
  { name: "round 3: mcp__ccxt__fetch", tool: "mcp__ccxt__fetch", sideEffect: "write" },
  {
    name: "round 3: mcp__alpaca__get_and_buy",
    tool: "mcp__alpaca__get_and_buy",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__kraken__query_private",
    tool: "mcp__kraken__query_private",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__binance__check_out",
    tool: "mcp__binance__check_out",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__wallet__sign_message",
    tool: "mcp__wallet__sign_message",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__evm__approve_erc20",
    tool: "mcp__evm__approve_erc20",
    sideEffect: "write",
  },
  { name: "round 3: mcp__evm__transferFrom", tool: "mcp__evm__transferFrom", sideEffect: "write" },
  // review round 4 (#1321): browser rows at the broker
  browser("app.mercury.com", "Approve all transfers"),
  browser("app.mercury.com", "Release pending transfers"),
  browser("secure.chase.com", "Submit all transfers"),
  browser("app.mercury.com", "Approve all transfers?", { role: "dialog" }),
  browser("secure.chase.com", "Leave this page? We will transfer $500 now.", { role: "dialog" }),
  browser("venmo.com", "Close this window to send $500", { role: "dialog" }),
  browser("secure.bankofamerica.com", "Submit", {
    pageUrl: "https://secure.bankofamerica.com/business/transfers/wire",
  }),
  browser("www.ally.com", "Confirm", { pageUrl: "https://www.ally.com/personal/transfers#/send" }),
  browser("secure.chase.com", "Confirm", { pageTitle: "Transfer: review" }),
  browser("www.coinbase.com", "Buy now", { role: "tab" }),
  // review round 4 (#1321): the reviewer's tool-name probe list
  {
    name: "round 4: mcp__business_trading__place_order",
    tool: "mcp__business_trading__place_order",
    sideEffect: "write",
  },
  { name: "round 4: mcp__ibkr__get_raw", tool: "mcp__ibkr__get_raw", sideEffect: "write" },
  {
    name: "round 4: mcp__alpaca__get_orders_then_cancel",
    tool: "mcp__alpaca__get_orders_then_cancel",
    sideEffect: "write",
  },
  { name: "round 4: mcp__alpaca__orders", tool: "mcp__alpaca__orders", sideEffect: "write" },
  {
    name: "round 4: mcp__alpaca__create_orders",
    tool: "mcp__alpaca__create_orders",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__kraken__get_private",
    tool: "mcp__kraken__get_private",
    sideEffect: "write",
  },
  { name: "round 4: mcp__alpaca__fetch_api", tool: "mcp__alpaca__fetch_api", sideEffect: "write" },
  { name: "round 4: mcp__evm__approve_nft", tool: "mcp__evm__approve_nft", sideEffect: "write" },
  {
    name: "round 4: mcp__trading_bus__place_order",
    tool: "mcp__trading_bus__place_order",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__ccxt__fetch_balance_and_withdraw",
    tool: "mcp__ccxt__fetch_balance_and_withdraw",
    sideEffect: "write",
  },
  // review round 5 (#1321): browser rows at the broker
  browser("secure.pnc.com", "Continue", { pageUrl: "https://secure.pnc.com/en/transfers" }),
  browser("banking.ing.de", "Weiter", { pageUrl: "https://banking.ing.de/de/ueberweisung" }),
  browser("olb.rbc.com", "Submit", { pageUrl: "https://olb.rbc.com/us/transfer" }),
  browser("secure.key.com", "Submit", { pageUrl: "https://secure.key.com/business/wire" }),
  browser("app.mercury.com", "View & approve transfers"),
  browser("app.mercury.com", "See all transfers and approve"),
  browser("www.commerzbank.de", "Alle Überweisungen freigeben"),
  browser("www.bbva.es", "Aprobar todas las transferencias"),
  browser("www.bnpparibas.com", "Valider tous les virements"),
  browser("www.hsbc.com", "Approva tutti i bonifici"),
  browser("app.mercury.com", "Approve", {
    pageUrl: "https://app.mercury.com/support#/transfers/approve",
  }),
  {
    name: "round 5: mcp__airbus_trading__place_order",
    tool: "mcp__airbus_trading__place_order",
    sideEffect: "write",
  },
  {
    name: "round 5: mcp__trading_games_broker__buy",
    tool: "mcp__trading_games_broker__buy",
    sideEffect: "write",
  },
  {
    name: "round 5: mcp__cards_trading__buy_stock",
    tool: "mcp__cards_trading__buy_stock",
    sideEffect: "write",
  },
  // review round 6 (#1321): the Link purchase tool on a venue tab (what its describeCall gives)
  {
    name: "Link purchase tool on coinbase: Buy now",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://www.coinbase.com"),
    meta: { control: { unreadable: true, pageUrl: "https://www.coinbase.com" } },
  },
  {
    name: "Link purchase tool on venmo: Pay",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://venmo.com"),
    meta: { control: { labels: ["Pay"], role: "button", submits: true } },
  },
  // review round 6 (#1321): read verb first, then a move or trade; listing plural, then an act
  browser("secure.chase.com", "Check and transfer $500"),
  browser("secure.chase.com", "View & transfer"),
  browser("robinhood.com", "Preview and buy now"),
  browser("www.coinbase.com", "View and swap"),
  browser("www.commerzbank.de", "Überweisungen absenden"),
  browser("www.commerzbank.de", "Alle Überweisungen abschicken"),
  browser("www.bnpparibas.com", "Tous les virements : effectuer"),
  browser("www.bbva.es", "Las transferencias pendientes: realizar"),
  browser("www.revolut.com", "Все переводы подтвердить"),
  browser("app.mercury.com", "Pending transfers: process now"),
  browser("app.mercury.com", "Recent transfers - repeat"),
  browser("app.mercury.com", "Scheduled transfers: run now"),
  browser("www.coinbase.com", "Next", { pageUrl: "https://www.coinbase.com/en/withdraw-funds" }),
  browser("secure.chase.com", "Your funds will be sent to John. Continue?", { role: "dialog" }),
  browser("venmo.com", "Discard? The payment will be sent anyway.", { role: "dialog" }),
  // #1321 follow-ups: crypto on-ramps, PayPal's person-to-person pages, "not affected" clauses
  browser("buy.moonpay.com", "Buy now", { submits: true }),
  browser("app.ramp.network", "Buy now", { submits: true }),
  browser("www.paypal.com", "Pay", {
    submits: true,
    pageUrl: "https://www.paypal.com/paypalme/john/50",
  }),
  {
    name: "Link purchase tool on moonpay: Buy now",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://buy.moonpay.com"),
    meta: { control: { unreadable: true, pageUrl: "https://buy.moonpay.com" } },
  },
  {
    name: "Link purchase tool on PayPal.Me",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://www.paypal.com"),
    meta: { control: { unreadable: true, pageUrl: "https://www.paypal.com/paypalme/john" } },
  },
  browser("venmo.com", "Leave this page? Send $500, balance is not affected.", { role: "dialog" }),
  // #1332 review B1–B3: money that will be sent, joined trade words, "start" after a listing
  browser("secure.chase.com", "Payment details: $500 will be sent to John. Confirm?", {
    role: "dialog",
  }),
  browser("secure.chase.com", "Your receipt: $500 will be sent to John. OK?", { role: "dialog" }),
  browser("wise.com", "Your money will be sent on Monday. Continue?", { role: "dialog" }),
  browser("app.mercury.com", "Your payment will be sent by ACH on 11/20. Continue?", {
    role: "dialog",
  }),
  browser("secure.chase.com", "$5,000 will be sent on 11/20 for John. OK?", { role: "dialog" }),
  browser("robinhood.com", "Preview and sell orders now"),
  browser("robinhood.com", "View and buy orders"),
  browser("www.coinbase.com", "See and swap quotes"),
  browser("secure.chase.com", "View and transfer orders"),
  browser("app.mercury.com", "Scheduled transfers: start now"),
  browser("app.mercury.com", "Pending transfers start"),
  // #1332 review N2, N3
  browser("www.paypal.com", "Pay $50", {
    submits: true,
    pageUrl: "https://www.paypal.com/us/en/myaccount/transfer/send",
  }),
  browser("www.paypal.com", "Pay", {
    submits: true,
    pageUrl: "https://www.paypal.com//paypalme/john/50",
  }),
  browser("crypto.link.com", "Buy now", { submits: true }),
  computer("com.robinhood.macos", "", { unreadable: true }),
  computer("com.google.Chrome", "Buy bitcoin"),
];

/**
 * Accepted over-blocks (#1332 review): refused although no money goes to a person. They fail
 * closed; each exemption tried for them reopened a real send. Do not "fix" them without the owner.
 */
const ACCEPTED_OVERBLOCKS: Row[] = [
  browser("secure.chase.com", "Your payment will be sent on 11/20. Continue?", { role: "dialog" }),
  browser("www.chase.com", "Your payment receipt will be sent by email. OK?", { role: "dialog" }),
  browser("robinhood.com", "See buy and sell prices"),
  browser("app.mercury.com", "Scheduled transfers start Monday"),
];

const MUST_NOT_BLOCK: Row[] = [
  { name: "tool calendar.create", tool: "calendar.create", sideEffect: "write" },
  { name: "tool Link purchase", tool: "link.purchase", sideEffect: "financial" },
  // The Link purchase tool (#1315) at a merchant: its describeCall gives the pay button it presses.
  {
    name: "Link purchase tool at a shop: Pay now",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://shop.example.com"),
    meta: { control: { labels: ["Pay now"], role: "button", submits: true } },
  },
  {
    name: "Link purchase tool on PayPal's checkout: Pay Now",
    tool: "checkout.pay_with_link",
    sideEffect: "financial",
    target: origin("https://www.paypal.com"),
    meta: { control: { labels: ["Pay Now"], role: "button", submits: true } },
  },
  { name: "tool payments.link_spend", tool: "payments.link_spend", sideEffect: "financial" },
  { name: "tool shop.place_order", tool: "shop.place_order", sideEffect: "financial" },
  { name: "mcp restaurant place_order", tool: "mcp__tacos__place_order", sideEffect: "write" },
  { name: "mcp github create_issue", tool: "mcp__github__create_issue", sideEffect: "write" },
  { name: "mcp exchange mail", tool: "mcp__outlook__send_mail", sideEffect: "write" },
  { name: "mcp portfolio read", tool: "mcp__robinhood_notes__list_notes", sideEffect: "read" },
  // checkouts and bills
  browser("shop.example.com", "Buy now"),
  browser("shop.example.com", "Place order"),
  browser("shop.example.com", "Pay $24.99"),
  browser("checkout.stripe.com", "Pay with Link"),
  browser("www.pge.com", "Pay bill"),
  browser("pay.coned.com", "Pay $120.50"),
  browser("www.paypal.com", "Pay Now"),
  browser("www.paypal.com", "Complete Purchase"),
  browser("shop.example.com", "Continue", {
    submits: true,
    formMethod: "post",
    formAction: "https://shop.example.com/checkout/payment",
  }),
  browser("www.chase.com", "Pay bill"),
  // reading
  browser("robinhood.com", "Account balance"),
  browser("www.chase.com", "View transactions"),
  browser("www.chase.com", "Transfer history"),
  browser("robinhood.com", "Order history"),
  // navigation
  browser("www.coinbase.com", "Buy", {
    role: "link",
    pageUrl: "https://www.coinbase.com/",
    href: "https://www.coinbase.com/buy",
  }),
  browser("www.chase.com", "Transfer money", {
    role: "link",
    href: "https://www.chase.com/transfers",
  }),
  // look-alike hosts
  browser("robinhood.com.evil.test", "Buy"),
  browser("notrobinhood.com", "Buy"),
  browser("chase.com.evil.test", "Transfer"),
  browser("gemini.google.com", "Send"),
  // ordinary words
  browser("mail.example.com", "Send message"),
  browser("files.example.com", "Transfer file"),
  computer("com.apple.mail", "Send"),
  computer("com.apple.AppStore", "Buy"),
  computer("com.robinhood.macos", "Account balance"),
  // review round 1 (#1321)
  browser("secure.chase.com", "Send code"),
  browser("secure.chase.com", "Send text"),
  browser("wise.com", "Send code"),
  browser("secure.chase.com", "Pay & transfer", { role: "button" }),
  browser("secure.chase.com", "Transfers", { role: "tab" }),
  browser("secure.chase.com", "Transfer activity"),
  browser("secure.chase.com", "Wire instructions"),
  browser("secure.chase.com", "Transfer limits"),
  browser("secure.chase.com", "Deposit details"),
  browser("secure.chase.com", "Pay card"),
  browser("secure.chase.com", "Order checks"),
  browser("secure.chase.com", "Deposit"),
  browser("www.schwab.com", "Trade ideas"),
  browser("www.schwab.com", "Order types explained"),
  browser("robinhood.com", "Sort order"),
  browser("robinhood.com", "Order card"),
  browser("robinhood.com", "Cover"),
  browser("robinhood.com", "Done", { pageUrl: "https://robinhood.com/news/buy-the-dip-article" }),
  browser("www.schwab.com", "Done", {
    pageUrl: "https://www.schwab.com/accounts/statements/#/trade-confirmations",
  }),
  browser("secure.chase.com", "Continue", { pageTitle: "Trading account overview" }),
  browser("www.etrade.com", "注文履歴", { role: "tab" }),
  browser("www.smbc.co.jp", "振込履歴"),
  browser("www.hsbc.com", "转账记录"),
  browser("www.upbit.com", "주문내역"),
  browser("www.shutterstock.com", "Buy stock photo"),
  browser("www.ebay.com", "Sell stock"),
  browser("www.doordash.com", "Place order"),
  browser("mail.google.com", "Send"),
  browser("www.godaddy.com", "Transfer domain"),
  browser("wetransfer.com", "Transfer"),
  browser("github.com", "Transfer repository"),
  browser("github.com", "Transfer issue"),
  browser("www.paypal.com", "Agree & Pay"),
  browser("www.paypal.com", "Buy now"),
  { name: "mcp photos buy_stock_photo", tool: "mcp__photos__buy_stock_photo", sideEffect: "write" },
  { name: "mcp doordash place_order", tool: "mcp__doordash__place_order", sideEffect: "write" },
  { name: "mcp ubereats submit_order", tool: "mcp__ubereats__submit_order", sideEffect: "write" },
  { name: "mcp shopify create_order", tool: "mcp__shopify__create_order", sideEffect: "write" },
  { name: "mcp robinhood get_quote", tool: "mcp__robinhood__get_quote", sideEffect: "read" },
  { name: "mcp coinbase get_balance", tool: "mcp__coinbase__get_balance", sideEffect: "read" },
  { name: "mcp wise get_rates", tool: "mcp__wise__get_rates", sideEffect: "read" },
  // review round 2 (#1321): browser rows at the broker
  browser("secure.chase.com", "We will send a code to your phone. Continue?", { role: "dialog" }),
  browser("secure.chase.com", "Leave this page? Your transfer won't be saved.", { role: "dialog" }),
  browser("ultimaterewardspoints.chase.com", "Buy gift card"),
  browser(
    "robinhood.com",
    "Search",
    {
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://robinhood.com/search",
      pageUrl: "https://robinhood.com/",
    },
    "browser.press",
  ),
  browser("www.chase.com", "Next", {
    pageUrl: "https://www.chase.com/personal/education/how-to-trade-stocks",
  }),
  browser("www.amazon.com", "Place your order"),
  browser("shop.example.com", "Send your order now?", { role: "dialog" }),
  // review round 2 (#1321): the reviewer's tool-name probe list
  { name: "round 2: mcp__ibis__get", tool: "mcp__ibis__get", sideEffect: "write" },
  {
    name: "round 2: mcp__ibis__create_record",
    tool: "mcp__ibis__create_record",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__mqtt-broker__publish",
    tool: "mcp__mqtt-broker__publish",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__kafka_broker__send_message",
    tool: "mcp__kafka_broker__send_message",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__message-broker__publish",
    tool: "mcp__message-broker__publish",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__card_trading__list_cards",
    tool: "mcp__card_trading__list_cards",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__pokemon_trading__create_listing",
    tool: "mcp__pokemon_trading__create_listing",
    sideEffect: "write",
  },
  { name: "round 2: mcp__tws_docs__search", tool: "mcp__tws_docs__search", sideEffect: "write" },
  {
    name: "round 2: mcp__libtrading__compile",
    tool: "mcp__libtrading__compile",
    sideEffect: "write",
  },
  { name: "round 2: mcp__gmail__send_email", tool: "mcp__gmail__send_email", sideEffect: "write" },
  {
    name: "round 2: mcp__plaid__get_transactions",
    tool: "mcp__plaid__get_transactions",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__amazon__place_order",
    tool: "mcp__amazon__place_order",
    sideEffect: "write",
  },
  {
    name: "round 2: mcp__slack__send_message",
    tool: "mcp__slack__send_message",
    sideEffect: "write",
  },
  { name: "round 2: mcp__twilio__send_sms", tool: "mcp__twilio__send_sms", sideEffect: "write" },
  { name: "round 2: mcp__email__send", tool: "mcp__email__send", sideEffect: "write" },
  // review round 3 (#1321): the reviewer's tool-name probe list
  {
    name: "round 3: mcp__coinbase__get_order_book",
    tool: "mcp__coinbase__get_order_book",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__alpaca__get_open_orders",
    tool: "mcp__alpaca__get_open_orders",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__alpaca__list_orders",
    tool: "mcp__alpaca__list_orders",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__robinhood__get_closing_price",
    tool: "mcp__robinhood__get_closing_price",
    sideEffect: "write",
  },
  {
    name: "round 3: mcp__eventbus-broker__publish",
    tool: "mcp__eventbus-broker__publish",
    sideEffect: "write",
  },
  { name: "round 3: mcp__redis_broker__set", tool: "mcp__redis_broker__set", sideEffect: "write" },
  { name: "round 3: mcp__card_broker__list", tool: "mcp__card_broker__list", sideEffect: "write" },
  // review round 4 (#1321): browser rows at the broker
  browser("secure.chase.com", "Recent transfers"),
  browser("secure.chase.com", "View all transfers"),
  browser("secure.chase.com", "Cancel scheduled transfers"),
  browser("secure.chase.com", "Discard changes to this transfer?", { role: "dialog" }),
  browser("www.chase.com", "Next", {
    pageUrl: "https://www.chase.com/personal/transfers/new-features",
  }),
  browser("www.chase.com", "Continue", { pageTitle: "Trade-in value | Chase Auto" }),
  // review round 4 (#1321): the reviewer's tool-name probe list
  {
    name: "round 4: mcp__alpaca__get_orders",
    tool: "mcp__alpaca__get_orders",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__alpaca__get_order_status",
    tool: "mcp__alpaca__get_order_status",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__coinbase__list_open_orders",
    tool: "mcp__coinbase__list_open_orders",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__omnibus-broker__publish",
    tool: "mcp__omnibus-broker__publish",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__robinhood__get_portfolio",
    tool: "mcp__robinhood__get_portfolio",
    sideEffect: "write",
  },
  {
    name: "round 4: mcp__ccxt__fetch_balance",
    tool: "mcp__ccxt__fetch_balance",
    sideEffect: "write",
  },
  // review round 5 (#1321)
  browser("app.mercury.com", "Stop all transfers"),
  browser("app.mercury.com", "Your recent transfers"),
  browser("wise.com", "Continue", { pageUrl: "https://wise.com/gb/send-money/" }),
  browser("secure.chase.com", "Discard this transfer?", { role: "dialog" }),
  browser("www.chase.com", "J", { role: "button" }),
  // #1321 follow-ups: PayPal's checkout stays a payment
  browser("www.paypal.com", "Pay Now", {
    submits: true,
    pageUrl: "https://www.paypal.com/checkoutnow?token=EC-1",
  }),
  // review round 6 (#1321)
  browser("robinhood.com", "View buy orders"),
  browser("robinhood.com", "Check sell price"),
  browser("www.commerzbank.de", "Alle Überweisungen"),
  browser("www.bbva.es", "Mis transferencias"),
  browser("www.revolut.com", "Все переводы"),
  browser("www.amazon.com", "View & buy again"),
  browser("mail.google.com", "View and send"),
  browser("shop.example.com", "Discard cart and pay?", { role: "dialog" }),
  browser("secure.chase.com", "Leave this page? Funds already transferred are not affected.", {
    role: "dialog",
  }),
  {
    name: "round 5: mcp__rabbitmq-broker__publish",
    tool: "mcp__rabbitmq-broker__publish",
    sideEffect: "write",
  },
  {
    name: "round 5: mcp__eventbus_broker__publish",
    tool: "mcp__eventbus_broker__publish",
    sideEffect: "write",
  },
  {
    name: "round 5: mcp__omnibus_broker__send",
    tool: "mcp__omnibus_broker__send",
    sideEffect: "write",
  },
  {
    name: "round 5: mcp__nats_broker__publish",
    tool: "mcp__nats_broker__publish",
    sideEffect: "write",
  },
  computer("com.apple.mail", "", { unreadable: true }),
];

const policies = [
  { name: "default policy", opts: {} },
  { name: "allow-all policy", opts: { policy: { allow: ["*"] } } },
];

describe("financial hard block: refused on every path", () => {
  for (const p of policies) {
    for (const mode of ["manual", "balanced", "auto"] as const) {
      it.each(MUST_BLOCK.map((r) => [r.name, r] as const))(
        `${p.name}, ${mode}: %s`,
        async (_name, r) => {
          const h = makeBroker(p.opts);
          const c = call(r.tool, r.sideEffect ?? "write", r.target, {
            meta: r.meta,
          } as never);
          const d = await h.broker.decide(c, { ...CTX, permissionMode: mode });
          expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
          expect(d.reason).toMatch(/yourself/);
        },
      );
    }
  }
});

describe("financial hard block: accepted over-blocks (fail closed)", () => {
  it.each(ACCEPTED_OVERBLOCKS.map((r) => [r.name, r] as const))("%s", async (_name, r) => {
    const h = makeBroker({});
    const c = call(r.tool, r.sideEffect ?? "write", r.target, { meta: r.meta } as never);
    const d = await h.broker.decide(c, { ...CTX, permissionMode: "auto" });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
  });
});

describe("financial hard block: ordinary actions keep their own rule", () => {
  it.each(MUST_NOT_BLOCK.map((r) => [r.name, r] as const))("%s", async (_name, r) => {
    const h = makeBroker({ policy: { allow: ["*"] } });
    const c = call(r.tool, r.sideEffect ?? "write", r.target, { meta: r.meta } as never);
    const d = await h.broker.decide(c, { ...CTX, permissionMode: "balanced" });
    expect(d.rule, r.name).not.toBe("prohibition:financial_transfer");
  });

  it("a checkout still reaches the Pay card (financial, ask)", async () => {
    const h = makeBroker();
    const r = browser("shop.example.com", "Place order");
    const c = call(r.tool, "financial", r.target, { meta: r.meta, kind: "purchase" } as never);
    const d = await h.broker.decide(c, { ...CTX, permissionMode: "auto" });
    expect(d.decision).toBe("ask");
    expect(d.scopesOffered).toEqual(["once"]);
  });
});

describe("financial hard block: no approval or standing grant unlocks it", () => {
  it("an approval for the same call is not honoured: the next decide still denies", async () => {
    const h = makeBroker();
    const r = browser("shop.example.com", "Place order");
    // The owner approves a checkout on the shop…
    const shop = call(r.tool, "financial", r.target, { meta: r.meta, kind: "purchase" } as never);
    const first = await h.broker.decide(shop, { ...CTX, permissionMode: "auto" });
    expect(first.decision).toBe("ask");
    // …and the same control label on a brokerage is still refused outright.
    const t = browser("robinhood.com", "Place order");
    const trade = call(t.tool, "financial", t.target, { meta: t.meta, kind: "purchase" } as never);
    const d = await h.broker.decide(trade, { ...CTX, permissionMode: "auto" });
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
    expect(d.scopesOffered ?? []).toEqual([]);
  });

  it("a control the executor could not read on a venue is refused, not asked", async () => {
    const h = makeBroker();
    const t = browser("www.chase.com", "", { unreadable: true });
    const d = await h.broker.decide(
      call(t.tool, "write", t.target, { meta: t.meta } as never),
      CTX,
    );
    expect(d).toMatchObject({ decision: "deny", rule: "prohibition:financial_transfer" });
  });
});

describe("financial hard block: browser channels and web apps (#1321 rounds 2 and 3)", () => {
  const act = (bundle: string) =>
    call("computer.act", "write", app(bundle), {
      kind: "computer_action",
      meta: { app: bundle, action: "click", control: { labels: ["Confirm"], role: "AXButton" } },
    } as never);

  it.each([
    "com.google.Chrome.beta",
    "com.microsoft.edgemac.Dev",
    "org.mozilla.firefoxdeveloperedition",
  ])("a browser channel (%s) is read-only, like the browser", async (bundle) => {
    const h = makeBroker({ policy: { allow: ["*"] } });
    const d = await h.broker.decide(act(bundle), { ...CTX, permissionMode: "auto" });
    expect(d).toMatchObject({ decision: "deny", rule: "app_tier:read" });
  });

  it.each(["com.google.Chrome.app.notion", "com.apple.Safari.WebApp.1234"])(
    "an installed web app (%s) keeps its tier: the gateway reads its page instead",
    async (bundle) => {
      const h = makeBroker({ policy: { allow: ["*"], apps: { [bundle]: "interact" } } });
      const d = await h.broker.decide(act(bundle), { ...CTX, permissionMode: "auto" });
      expect(d.rule ?? "").not.toMatch(/^app_tier:(read|off)$/);
      expect(d.rule).not.toBe("prohibition:financial_transfer");
    },
  );
});
