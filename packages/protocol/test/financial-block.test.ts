import { describe, expect, it } from "vitest";
import {
  type FinancialAction,
  financialBlock,
  isTradeOrTransferText,
  venueOfApp,
  venueOfHost,
} from "../src/financial-block.ts";

/** Two lists, as for every classifier here: what must block, and near-misses that must not. */
const MUST_BLOCK: [string, FinancialAction][] = [
  // brokerage: an order ticket, buy and sell
  ["robinhood Buy", { pageUrl: "https://robinhood.com/stocks/AAPL", labels: ["Buy"] }],
  ["robinhood Place order", { pageUrl: "https://robinhood.com/", labels: ["Place order"] }],
  ["schwab Submit order", { origin: "https://client.schwab.com", labels: ["Submit order"] }],
  ["fidelity Sell", { origin: "https://digital.fidelity.com", labels: ["Sell"] }],
  [
    "ibkr Buy 10 shares",
    { origin: "https://www.interactivebrokers.com", labels: ["Buy 10 shares"] },
  ],
  [
    "brokerage Confirm on ticket",
    {
      pageUrl: "https://trade.webull.com/order-ticket/AAPL",
      labels: ["Confirm"],
      role: "button",
    },
  ],
  // exchange
  ["coinbase Buy", { origin: "https://www.coinbase.com", labels: ["Buy"] }],
  ["coinbase Send crypto", { origin: "https://www.coinbase.com", labels: ["Send"] }],
  ["kraken Withdraw", { origin: "https://pro.kraken.com", labels: ["Withdraw"] }],
  ["binance Convert", { origin: "https://www.binance.com", labels: ["Convert"] }],
  ["uniswap Swap", { origin: "https://app.uniswap.org", labels: ["Swap"] }],
  // bank
  ["chase Transfer money", { origin: "https://secure.chase.com", labels: ["Transfer money"] }],
  ["bofa Transfer", { origin: "https://www.bankofamerica.com", labels: ["Transfer"] }],
  [
    "bank Send with Zelle",
    { origin: "https://www.wellsfargo.com", labels: ["Send money with Zelle"] },
  ],
  ["bank Wire", { origin: "https://www.citi.com", labels: ["Wire transfer"] }],
  ["bank Withdraw", { origin: "https://www.capitalone.com", labels: ["Withdraw"] }],
  [
    "bank Confirm on transfer page",
    {
      pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfers/confirm",
      labels: ["Confirm"],
      role: "button",
    },
  ],
  [
    "bank submit POST to transfers",
    {
      origin: "https://www.ally.com",
      labels: ["Continue"],
      submits: true,
      formMethod: "post",
      formAction: "https://www.ally.com/api/transfers/submit",
    },
  ],
  ["real bank subdomain", { origin: "https://online.chase.com", labels: ["Transfer"] }],
  ["fintech Send", { origin: "https://wise.com", labels: ["Send"] }],
  // p2p
  ["venmo Pay", { origin: "https://venmo.com", labels: ["Pay"] }],
  ["cash app Send $50", { origin: "https://cash.app", labels: ["Send $50"] }],
  ["paypal Send money", { origin: "https://www.paypal.com", labels: ["Send Money"] }],
  ["western union Send", { origin: "https://www.westernunion.com", labels: ["Send"] }],
  // computer use: a native app by bundle id
  ["native broker app", { app: "com.robinhood.macos", labels: ["Buy"], role: "AXButton" }],
  ["native exchange app", { app: "com.coinbase.desktop", labels: ["Withdraw"] }],
  ["native bank app", { app: "com.chase.mobile", labels: ["Transfer"] }],
  ["native wallet app", { app: "io.metamask.desktop", labels: ["Send"] }],
  // a browser app showing a venue: the page decides
  [
    "chrome on a brokerage",
    { app: "com.google.Chrome", pageUrl: "https://www.schwab.com/trade", labels: ["Place order"] },
  ],
  // non-English labels
  ["es Transferir", { origin: "https://www.bbva.es", labels: ["Transferir"] }],
  ["fr Virement", { origin: "https://www.bnpparibas.com", labels: ["Effectuer un virement"] }],
  ["de Überweisung", { origin: "https://www.commerzbank.de", labels: ["Überweisung"] }],
  ["it Bonifico", { origin: "https://www.hsbc.com", labels: ["Bonifico"] }],
  ["pt Transferir", { origin: "https://nubank.com.br", labels: ["Transferir"] }],
  ["ja 送金", { origin: "https://www.smbc.co.jp", labels: ["送金する"] }],
  ["ja 注文", { origin: "https://www.etrade.com", labels: ["注文を確定"] }],
  ["zh 转账", { origin: "https://www.revolut.com", labels: ["转账"] }],
  ["ko 송금", { origin: "https://www.upbit.com", labels: ["송금"] }],
  ["ko 매수", { origin: "https://www.bithumb.com", labels: ["매수"] }],
  ["de Kaufen on exchange", { origin: "https://www.bitpanda.com", labels: ["Kaufen"] }],
  ["ar تحويل", { origin: "https://www.hsbc.com", labels: ["تحويل"] }],
  ["ru Перевод", { origin: "https://www.revolut.com", labels: ["Перевод"] }],
  // strong phrases anywhere
  [
    "unlisted site, buy stock",
    { origin: "https://app.unknown-broker.example", labels: ["Buy stock"] },
  ],
  ["unlisted site, market order", { origin: "https://x.example", labels: ["Submit market order"] }],
  [
    "unlisted site, transfer between accounts",
    { origin: "https://cu.example", labels: ["Transfer between accounts"] },
  ],
  ["unlisted site, send bitcoin", { origin: "https://w.example", labels: ["Send Bitcoin"] }],
  ["parent heading names it", { origin: "https://w.example", labels: ["OK", "Send money"] }],
  // review round 1: browser drag, Enter in a field, icon-only controls, links that are script
  [
    "drag from Buy to itself",
    { origin: "https://robinhood.com", labels: ["Buy"], alsoLabels: ["Buy"], role: "button" },
  ],
  [
    "drag whose far end is Buy",
    { origin: "https://robinhood.com", labels: ["Chart"], alsoLabels: ["Buy"], role: "button" },
  ],
  [
    "icon-only submit on a brokerage",
    { origin: "https://robinhood.com", labels: [""], role: "button", submits: true },
  ],
  [
    "icon-only button on a bank",
    { origin: "https://secure.chase.com", labels: [""], role: "button" },
  ],
  [
    "Buy link whose href is javascript:",
    {
      origin: "https://www.coinbase.com",
      labels: ["Buy"],
      role: "link",
      href: "javascript:void(0)",
    },
  ],
  [
    "Buy link whose href is #",
    {
      origin: "https://www.coinbase.com",
      pageUrl: "https://www.coinbase.com/trade",
      labels: ["Buy"],
      role: "link",
      href: "https://www.coinbase.com/trade#",
    },
  ],
  ["Buy link with no href", { origin: "https://www.coinbase.com", labels: ["Buy"], role: "link" }],
  [
    "page dialog on a brokerage",
    { origin: "https://robinhood.com", labels: ["Sell 10 shares?"], role: "dialog" },
  ],
  [
    "page dialog on P2P",
    {
      origin: "https://venmo.com",
      labels: ["Are you sure you want to send $500 to Sam?"],
      role: "dialog",
    },
  ],
  // trade words on banks, P2P apps and mixed venues
  ["chase Buy", { origin: "https://secure.chase.com", labels: ["Buy"] }],
  ["chase Place order", { origin: "https://secure.chase.com", labels: ["Place order"] }],
  ["sofi Buy", { origin: "https://www.sofi.com", labels: ["Buy"] }],
  ["ally invest Sell", { origin: "https://live.invest.ally.com", labels: ["Sell"] }],
  ["revolut Buy", { origin: "https://app.revolut.com", labels: ["Buy"] }],
  ["ing Kaufen", { origin: "https://banking.ing.de", labels: ["Kaufen"] }],
  ["cash app Buy", { origin: "https://cash.app", labels: ["Buy"] }],
  ["cash app Cash Out", { origin: "https://cash.app", labels: ["Cash Out"] }],
  [
    "paypal crypto Buy",
    {
      origin: "https://www.paypal.com",
      pageUrl: "https://www.paypal.com/myaccount/crypto/buy",
      labels: ["Buy"],
    },
  ],
  // brokerage-only words
  ["robinhood Invest", { origin: "https://robinhood.com", labels: ["Invest"] }],
  ["robinhood Close position", { origin: "https://robinhood.com", labels: ["Close position"] }],
  ["robinhood Exercise", { origin: "https://robinhood.com", labels: ["Exercise"] }],
  ["wealthfront Invest now", { origin: "https://www.wealthfront.com", labels: ["Invest now"] }],
  // non-English confirm steps
  [
    "de Bestätigen on /ueberweisung",
    {
      origin: "https://www.commerzbank.de",
      pageUrl: "https://www.commerzbank.de/ueberweisung",
      labels: ["Bestätigen"],
      role: "button",
    },
  ],
  [
    "es Confirmar on /transferencias/confirmar",
    {
      origin: "https://www.bbva.es",
      pageUrl: "https://www.bbva.es/transferencias/confirmar",
      labels: ["Confirmar"],
      role: "button",
    },
  ],
  [
    "de Jetzt ausführen on /ueberweisung",
    {
      origin: "https://www.commerzbank.de",
      pageUrl: "https://www.commerzbank.de/ueberweisung",
      labels: ["Jetzt ausführen"],
      role: "button",
    },
  ],
  // more words in more languages
  ["fr Passer l'ordre", { origin: "https://www.degiro.com", labels: ["Passer l'ordre"] }],
  ["it Conferma ordine", { origin: "https://www.degiro.com", labels: ["Conferma ordine"] }],
  ["es Confirmar orden", { origin: "https://www.degiro.com", labels: ["Confirmar orden"] }],
  ["ja 購入する", { origin: "https://bitflyer.com", labels: ["購入する"] }],
  ["zh 立即购买", { origin: "https://www.binance.com", labels: ["立即购买"] }],
  ["zh 提币", { origin: "https://www.binance.com", labels: ["提币"] }],
  ["zh 交易", { origin: "https://www.binance.com", labels: ["交易"] }],
  ["zh 兑换", { origin: "https://www.binance.com", labels: ["兑换"] }],
  ["zh 发送", { origin: "https://www.okx.com", labels: ["发送"] }],
  ["ko 보내기", { origin: "https://www.upbit.com", labels: ["보내기"] }],
  ["ko 구매", { origin: "https://www.upbit.com", labels: ["구매"] }],
  ["hi पैसे भेजें", { origin: "https://www.hdfcbank.com", labels: ["पैसे भेजें"] }],
  ["ar أرسل", { origin: "https://www.hsbc.com", labels: ["أرسل"] }],
  ["ar اشترِ", { origin: "https://www.binance.com", labels: ["اشترِ"] }],
  ["ru Отправить", { origin: "https://www.revolut.com", labels: ["Отправить"] }],
  ["pt Pix", { origin: "https://nubank.com.br", labels: ["Pix"] }],
  // invisible characters inside the word
  ["soft hyphen", { origin: "https://secure.chase.com", labels: ["Trans­fer"] }],
  ["zero-width space", { origin: "https://venmo.com", labels: ["P​ay"] }],
  ["zero-width joiner", { origin: "https://robinhood.com", labels: ["B‍uy"] }],
  // wallet extensions
  [
    "MetaMask Confirm",
    {
      origin: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn",
      labels: ["Confirm"],
      role: "button",
    },
  ],
  [
    "MetaMask Send",
    { origin: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn", labels: ["Send"] },
  ],
  [
    "Phantom Approve",
    { origin: "chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa", labels: ["Approve"] },
  ],
  // venues that were not listed
  ["merrill Buy", { origin: "https://olui2.fs.ml.com", labels: ["Buy"] }],
  ["thinkorswim Buy", { origin: "https://trade.thinkorswim.com", labels: ["Buy"] }],
  ["zelle.com Send", { origin: "https://www.zelle.com", labels: ["Send"] }],
  ["transferwise Send", { origin: "https://transferwise.com", labels: ["Send"] }],
  ["sushi Swap", { origin: "https://www.sushi.com", labels: ["Swap"] }],
  ["opensea Buy now", { origin: "https://opensea.io", labels: ["Buy now"] }],
  ["jpmorgan Transfer", { origin: "https://secure.jpmorgan.com", labels: ["Transfer"] }],
  ["trade republic Kaufen", { origin: "https://app.traderepublic.com", labels: ["Kaufen"] }],
  // review round 2: confirm-step context (a regression from round 1)
  [
    "capitalone /accounts/transfer-money Confirm",
    { pageUrl: "https://myaccounts.capitalone.com/accounts/transfer-money", labels: ["Confirm"] },
  ],
  [
    "chase /payments/transfer-funds/review Confirm",
    { pageUrl: "https://secure.chase.com/payments/transfer-funds/review", labels: ["Confirm"] },
  ],
  [
    "chase #/dashboard/transfer-money/verify Confirm",
    {
      pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfer-money/verify",
      labels: ["Confirm"],
    },
  ],
  [
    "chase /move-money/review Confirm",
    { pageUrl: "https://secure.chase.com/move-money/review", labels: ["Confirm"] },
  ],
  [
    "title Chase | Transfer money, Confirm",
    {
      origin: "https://secure.chase.com",
      pageTitle: "Chase | Transfer money",
      labels: ["Confirm"],
    },
  ],
  [
    "title Capital One - Transfer Money, Submit",
    {
      origin: "https://myaccounts.capitalone.com",
      pageTitle: "Capital One - Transfer Money",
      labels: ["Submit"],
    },
  ],
  [
    "schwab /app/trade-ticket Place",
    { pageUrl: "https://client.schwab.com/app/trade-ticket", labels: ["Place"] },
  ],
  ["upbit 인증 후 출금", { origin: "https://upbit.com", labels: ["인증 후 출금"] }],
  ["smbc 認証して振込", { origin: "https://www.smbc.co.jp", labels: ["認証して振込"] }],
  ["hsbc 转账（说明）", { origin: "https://www.hsbc.com", labels: ["转账（说明）"] }],
  [
    "Buy 履歴 (English act, CJK read word)",
    { origin: "https://robinhood.com", labels: ["Buy 履歴"] },
  ],
  // Enter in a GET or script form
  [
    "venmo note field Enter",
    {
      origin: "https://account.venmo.com",
      pageUrl: "https://account.venmo.com/pay",
      labels: ["What's it for?"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://account.venmo.com/pay",
    },
  ],
  [
    "chase Amount Enter on #/dashboard/transfer/add",
    {
      origin: "https://secure.chase.com",
      pageUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/transfer/add",
      labels: ["Amount"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://secure.chase.com/web/auth/dashboard",
    },
  ],
  [
    "Enter in a field of a form with no action",
    { origin: "https://venmo.com", labels: ["Note"], role: "textbox", submits: true },
  ],
  // trade verbs are never exempted on a brokerage
  ["robinhood Buy options", { origin: "https://robinhood.com", labels: ["Buy options"] }],
  ["robinhood Sell options", { origin: "https://robinhood.com", labels: ["Sell options"] }],
  ["robinhood Trade options", { origin: "https://robinhood.com", labels: ["Trade options"] }],
  [
    "robinhood Order 10 AAPL shares",
    { origin: "https://robinhood.com", labels: ["Order 10 AAPL shares"] },
  ],
  [
    "robinhood Submit AAPL order",
    { origin: "https://robinhood.com", labels: ["Submit AAPL order"] },
  ],
  ["robinhood Place my order", { origin: "https://robinhood.com", labels: ["Place my order"] }],
  ["uniswap Swap link", { origin: "https://app.uniswap.org", labels: ["Swap link"] }],
  ["venmo Send link", { origin: "https://venmo.com", labels: ["Send link"] }],
  ["venmo Pay & transfer", { origin: "https://venmo.com", labels: ["Pay & transfer"] }],
  ["chase Transfer code", { origin: "https://www.chase.com", labels: ["Transfer code"] }],
  [
    "chase Send code and transfer $500",
    { origin: "https://www.chase.com", labels: ["Send code and transfer $500"] },
  ],
  ["chase Order alone", { origin: "https://secure.chase.com", labels: ["Order"] }],
  // roles and labels with no word
  [
    "robinhood generic with no name",
    { origin: "https://robinhood.com", labels: [""], role: "generic" },
  ],
  ["robinhood img with no name", { origin: "https://robinhood.com", labels: [""], role: "img" }],
  [
    "robinhood AXGroup with no name",
    { pageUrl: "https://robinhood.com/x", labels: [""], role: "AXGroup" },
  ],
  ["robinhood arrow button", { origin: "https://robinhood.com", labels: ["→"], role: "button" }],
  [
    "robinhood whitespace button",
    { origin: "https://robinhood.com", labels: ["   "], role: "button" },
  ],
  [
    "tab that submits Buy",
    { origin: "https://robinhood.com", labels: ["Buy"], role: "tab", submits: true },
  ],
  ["chase tab Transfer", { origin: "https://www.chase.com", labels: ["Transfer"], role: "tab" }],
  [
    "segmented AXRadioButton Buy",
    { pageUrl: "https://robinhood.com/x", labels: ["Buy"], role: "AXRadioButton" },
  ],
  [
    "drag from a link to Buy",
    {
      origin: "https://robinhood.com",
      pageUrl: "https://robinhood.com/x",
      labels: ["Read more"],
      role: "link",
      href: "https://robinhood.com/news",
      alsoLabels: ["Buy"],
    },
  ],
  [
    "drag from a tab to Buy",
    { origin: "https://robinhood.com", labels: ["News"], role: "tab", alsoLabels: ["Buy"] },
  ],
  [
    "drag onto a control with no name",
    { origin: "https://robinhood.com", labels: ["Portfolio"], role: "heading", alsoLabels: [""] },
  ],
  [
    "link that names the final step",
    {
      pageUrl: "https://robinhood.com/stocks/AAPL",
      labels: ["Submit order"],
      role: "link",
      href: "https://robinhood.com/stocks/AAPL/order",
    },
  ],
  // marks that NFKC leaves in place
  ["combining dot in Buy", { origin: "https://robinhood.com", labels: ["Bu̇y"] }],
  ["variation selector after Buy", { origin: "https://robinhood.com", labels: ["Buy️"] }],
  ["Hangul filler in Transfer", { origin: "https://www.chase.com", labels: ["Transㅤfer"] }],
  ["word joiner in Sell", { origin: "https://robinhood.com", labels: ["Se⁠ll"] }],
  ["tag character in Transfer", { origin: "https://www.chase.com", labels: ["Trans\u{E0041}fer"] }],
  // a wallet extension's own dialog
  [
    "MetaMask dialog Confirm transaction?",
    {
      origin: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn",
      labels: ["Confirm transaction?"],
      role: "dialog",
    },
  ],
  [
    "chase dialog Transfer $500 to savings?",
    { origin: "https://www.chase.com", labels: ["Transfer $500 to savings?"], role: "dialog" },
  ],
  // iPhone and iPad apps on the Mac, and 発注
  ["Coinbase iOS app", { app: "com.vilcsak.bitcoin2", labels: ["Send"] }],
  ["Venmo iOS app", { app: "net.kortina.labs.Venmo", labels: ["Pay"] }],
  ["PayPal iOS app", { app: "com.yourcompany.PPClient", labels: ["Send"] }],
  ["Wise iOS app", { app: "com.transferwise.Transferwise", labels: ["Send"] }],
  ["Binance iOS app", { app: "com.czzhao.binance", labels: ["Buy"] }],
  ["Navy Federal iPad app", { app: "com.navyfederal.navyfederal", labels: ["Transfer"] }],
  ["Exodus Send", { app: "com.electron.exodus", labels: ["Send"] }],
  ["sbisec 発注", { origin: "https://site1.sbisec.co.jp", labels: ["発注"] }],
];

const MUST_NOT_BLOCK: [string, FinancialAction][] = [
  // ordinary checkouts and bills
  [
    "buy shoes at a store",
    { origin: "https://shop.example.com", labels: ["Buy now"], role: "button" },
  ],
  ["place order at a store", { origin: "https://shop.example.com", labels: ["Place order"] }],
  ["pay at a merchant", { origin: "https://shop.example.com", labels: ["Pay $24.99"] }],
  [
    "checkout form post",
    {
      origin: "https://shop.example.com",
      labels: ["Continue"],
      submits: true,
      formMethod: "post",
      formAction: "https://shop.example.com/checkout/payment",
    },
  ],
  ["utility bill on the utility's site", { origin: "https://www.pge.com", labels: ["Pay bill"] }],
  ["utility Pay $120.50", { origin: "https://pay.coned.com", labels: ["Pay $120.50"] }],
  [
    "bank-transfer payment method at a merchant",
    { origin: "https://shop.example.de", labels: ["Per Überweisung bezahlen"] },
  ],
  [
    "wire transfer payment method",
    { origin: "https://shop.example.com", labels: ["Pay by wire transfer"] },
  ],
  ["Stripe Link checkout", { origin: "https://checkout.stripe.com", labels: ["Pay with Link"] }],
  ["Link on a merchant", { origin: "https://shop.example.com", labels: ["Pay with Link"] }],
  ["paypal checkout Pay Now", { origin: "https://www.paypal.com", labels: ["Pay Now"] }],
  ["paypal Complete Purchase", { origin: "https://www.paypal.com", labels: ["Complete Purchase"] }],
  ["paypal Continue", { origin: "https://www.paypal.com", labels: ["Continue"], role: "button" }],
  ["bank bill pay", { origin: "https://www.chase.com", labels: ["Pay bill"] }],
  // reading
  ["brokerage balance", { origin: "https://robinhood.com", labels: ["Account balance"] }],
  ["brokerage positions", { origin: "https://robinhood.com", labels: ["Portfolio"] }],
  ["bank transactions", { origin: "https://www.chase.com", labels: ["View transactions"] }],
  ["bank statements", { origin: "https://www.chase.com", labels: ["Statements"] }],
  ["transfer history", { origin: "https://www.chase.com", labels: ["Transfer history"] }],
  ["order history", { origin: "https://robinhood.com", labels: ["Order history"] }],
  ["order status", { origin: "https://www.schwab.com", labels: ["Order status"] }],
  ["quote", { origin: "https://www.coinbase.com", labels: ["Get a quote"] }],
  ["mobile check deposit", { origin: "https://www.chase.com", labels: ["Deposit a check"] }],
  ["bank Sign in", { origin: "https://www.chase.com", labels: ["Sign in"], role: "button" }],
  ["bank Continue", { origin: "https://www.chase.com", labels: ["Continue"], role: "button" }],
  [
    "bank Cancel in transfers section",
    { origin: "https://www.chase.com", labels: ["Cancel", "Transfers"] },
  ],
  ["bank Confirm elsewhere", { pageUrl: "https://www.chase.com/security", labels: ["Confirm"] }],
  // navigation never trades
  [
    "link Buy",
    {
      origin: "https://www.coinbase.com",
      pageUrl: "https://www.coinbase.com/",
      labels: ["Buy"],
      role: "link",
      href: "https://www.coinbase.com/buy",
    },
  ],
  [
    "link Transfer money",
    {
      origin: "https://www.chase.com",
      labels: ["Transfer money"],
      role: "link",
      href: "https://www.chase.com/transfers",
    },
  ],
  [
    "link Read more",
    {
      origin: "https://robinhood.com",
      labels: ["Read more"],
      role: "link",
      href: "https://robinhood.com/us/en/learn/articles/x",
    },
  ],
  ["AXLink Withdraw", { origin: "https://www.kraken.com", labels: ["Withdraw"], role: "AXLink" }],
  [
    "bank GET form",
    {
      origin: "https://www.chase.com",
      labels: ["Search"],
      submits: true,
      formMethod: "get",
      formAction: "https://www.chase.com/transfers/search",
    },
  ],
  // look-alike hosts are not the venue
  ["robinhood.com.evil.test", { origin: "https://robinhood.com.evil.test", labels: ["Buy"] }],
  [
    "evil host with robinhood in path",
    { origin: "https://evil.test/robinhood.com", labels: ["Sell"] },
  ],
  ["prefix glued on", { origin: "https://notrobinhood.com", labels: ["Buy"] }],
  ["userinfo trick", { origin: "https://robinhood.com@evil.test", labels: ["Buy"] }],
  ["bank lookalike", { origin: "https://chase.com.evil.test", labels: ["Transfer"] }],
  ["bank homoglyph", { origin: "https://chаse.com", labels: ["Transfer"] }],
  [
    "gemini.google.com is not gemini.com",
    { origin: "https://gemini.google.com", labels: ["Send"] },
  ],
  // ordinary words that share a verb
  ["send message", { origin: "https://mail.example.com", labels: ["Send message"] }],
  ["transfer a file", { origin: "https://files.example.com", labels: ["Transfer file"] }],
  ["wire up", { origin: "https://dev.example.com", labels: ["Wire up the hooks"] }],
  ["send feedback", { origin: "https://app.example.com", labels: ["Send feedback"] }],
  ["buy tickets", { origin: "https://tickets.example.com", labels: ["Buy tickets"] }],
  ["trade cards", { origin: "https://cards.example.com", labels: ["Trade cards"] }],
  ["sell your car", { origin: "https://cars.example.com", labels: ["Sell your car"] }],
  ["shares of a document", { origin: "https://docs.example.com", labels: ["Shares"] }],
  ["native shop app", { app: "com.apple.AppStore", labels: ["Buy"] }],
  ["native mail app Send", { app: "com.apple.mail", labels: ["Send"] }],
  ["native banking-looking but not listed", { app: "com.example.budget", labels: ["Transfer"] }],
  ["empty", {}],
  // review round 1: sign-in codes, menus, tabs and reading screens on a venue
  ["chase Send code", { origin: "https://secure.chase.com", labels: ["Send code"] }],
  ["chase Send text", { origin: "https://secure.chase.com", labels: ["Send text"] }],
  ["wise Send code", { origin: "https://wise.com", labels: ["Send code"] }],
  ["coinbase Send code", { origin: "https://www.coinbase.com", labels: ["Send code"] }],
  [
    "chase Pay & transfer menu",
    { origin: "https://secure.chase.com", labels: ["Pay & transfer"], role: "button" },
  ],
  ["chase Pay and transfer", { origin: "https://secure.chase.com", labels: ["Pay and transfer"] }],
  [
    "chase Transfers tab",
    { origin: "https://secure.chase.com", labels: ["Transfers"], role: "tab" },
  ],
  [
    "chase Transfer activity",
    { origin: "https://secure.chase.com", labels: ["Transfer activity"] },
  ],
  [
    "chase Wire instructions",
    { origin: "https://secure.chase.com", labels: ["Wire instructions"] },
  ],
  ["chase Transfer limits", { origin: "https://secure.chase.com", labels: ["Transfer limits"] }],
  ["chase Deposit details", { origin: "https://secure.chase.com", labels: ["Deposit details"] }],
  ["chase Deposit", { origin: "https://secure.chase.com", labels: ["Deposit"] }],
  ["chase Pay card", { origin: "https://secure.chase.com", labels: ["Pay card"] }],
  ["chase Order checks", { origin: "https://secure.chase.com", labels: ["Order checks"] }],
  ["schwab Trade ideas", { origin: "https://www.schwab.com", labels: ["Trade ideas"] }],
  [
    "schwab Order types explained",
    { origin: "https://www.schwab.com", labels: ["Order types explained"] },
  ],
  ["robinhood Sort order", { origin: "https://robinhood.com", labels: ["Sort order"] }],
  ["robinhood Order card", { origin: "https://robinhood.com", labels: ["Order card"] }],
  ["robinhood Cover", { origin: "https://robinhood.com", labels: ["Cover"] }],
  [
    "research article Done",
    {
      origin: "https://robinhood.com",
      pageUrl: "https://robinhood.com/news/buy-the-dip-article",
      labels: ["Done"],
      role: "button",
    },
  ],
  [
    "trade confirmations statement Done",
    {
      origin: "https://www.schwab.com",
      pageUrl: "https://www.schwab.com/accounts/statements/#/trade-confirmations",
      labels: ["Done"],
      role: "button",
    },
  ],
  [
    "Trading account overview Continue",
    {
      origin: "https://secure.chase.com",
      pageTitle: "Trading account overview",
      labels: ["Continue"],
      role: "button",
    },
  ],
  ["ja 注文履歴 tab", { origin: "https://www.etrade.com", labels: ["注文履歴"], role: "tab" }],
  ["ja 注文履歴", { origin: "https://www.etrade.com", labels: ["注文履歴"] }],
  ["ja 振込履歴", { origin: "https://www.smbc.co.jp", labels: ["振込履歴"] }],
  ["zh 转账记录", { origin: "https://www.hsbc.com", labels: ["转账记录"] }],
  ["ko 주문내역", { origin: "https://www.upbit.com", labels: ["주문내역"] }],
  [
    "stock photos",
    { origin: "https://www.shutterstock.com", labels: ["Buy stock photo"], role: "button" },
  ],
  ["sell stock on an auction site", { origin: "https://www.ebay.com", labels: ["Sell stock"] }],
  ["doordash Place order", { origin: "https://www.doordash.com", labels: ["Place order"] }],
  ["gmail Send", { origin: "https://mail.google.com", labels: ["Send"] }],
  ["godaddy Transfer domain", { origin: "https://www.godaddy.com", labels: ["Transfer domain"] }],
  ["Transfer call", { origin: "https://voip.example.com", labels: ["Transfer call"] }],
  ["wetransfer Transfer", { origin: "https://wetransfer.com", labels: ["Transfer"] }],
  ["github Transfer repository", { origin: "https://github.com", labels: ["Transfer repository"] }],
  ["github Transfer issue", { origin: "https://github.com", labels: ["Transfer issue"] }],
  ["paypal Pay", { origin: "https://www.paypal.com", labels: ["Pay"] }],
  ["paypal Agree & Pay", { origin: "https://www.paypal.com", labels: ["Agree & Pay"] }],
  ["paypal Buy now at checkout", { origin: "https://www.paypal.com", labels: ["Buy now"] }],
  [
    "wallet extension Back",
    { origin: "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn", labels: ["Back"] },
  ],
  // review round 2
  [
    "chase dialog: send a code",
    {
      origin: "https://secure.chase.com",
      labels: ["We will send a code to your phone. Continue?"],
      role: "dialog",
    },
  ],
  [
    "chase dialog: leave page",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? Your transfer won't be saved."],
      role: "dialog",
    },
  ],
  [
    "smbc 振込履歴 button",
    { origin: "https://www.smbc.co.jp", labels: ["振込履歴"], role: "button" },
  ],
  [
    "hsbc 转账记录 button",
    { origin: "https://www.hsbc.com", labels: ["转账记录"], role: "button" },
  ],
  ["upbit 주문내역 button", { origin: "https://upbit.com", labels: ["주문내역"], role: "button" }],
  ["zh 发送验证码", { origin: "https://www.binance.com", labels: ["发送验证码"] }],
  [
    "chase Next on an education article",
    {
      pageUrl: "https://www.chase.com/personal/education/how-to-trade-stocks",
      labels: ["Next"],
      role: "button",
    },
  ],
  [
    "Enter in a GET search form on robinhood",
    {
      origin: "https://robinhood.com",
      pageUrl: "https://robinhood.com/",
      labels: ["Search"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://robinhood.com/search",
    },
  ],
  [
    "Enter in a searchbox",
    { origin: "https://robinhood.com", labels: ["Search"], role: "searchbox", submits: true },
  ],
  [
    "chase rewards Buy gift card",
    { origin: "https://ultimaterewardspoints.chase.com", labels: ["Buy gift card"] },
  ],
  ["amazon Place your order", { origin: "https://www.amazon.com", labels: ["Place your order"] }],
  ["amazon Buy Now", { origin: "https://www.amazon.com", labels: ["Buy Now"] }],
  [
    "shop dialog Send your order now?",
    { origin: "https://shop.example.com", labels: ["Send your order now?"], role: "dialog" },
  ],
  ["shop Sell my stock", { origin: "https://shop.example.com", labels: ["Sell my stock"] }],
  [
    "shop Buy in stock items",
    { origin: "https://shop.example.com", labels: ["Buy in stock items"] },
  ],
  ["robinhood Invest tab", { origin: "https://robinhood.com", labels: ["Invest"], role: "tab" }],
  [
    "robinhood unnamed text field",
    { origin: "https://robinhood.com", labels: [""], role: "textbox" },
  ],
  ["robinhood unnamed tab", { origin: "https://robinhood.com", labels: [""], role: "tab" }],
];

describe("financialBlock: must block", () => {
  it.each(MUST_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeDefined();
  });
});

describe("financialBlock: must not block", () => {
  it.each(MUST_NOT_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeUndefined();
  });
});

describe("venues", () => {
  it("matches a registered domain and its real subdomains only", () => {
    expect(venueOfHost("https://robinhood.com")).toBe("brokerage");
    expect(venueOfHost("https://www.robinhood.com/x")).toBe("brokerage");
    expect(venueOfHost("secure.chase.com")).toBe("bank");
    expect(venueOfHost("https://ROBINHOOD.COM.")).toBe("brokerage");
    expect(venueOfHost("https://robinhood.com.evil.test")).toBeUndefined();
    expect(venueOfHost("https://evilrobinhood.com")).toBeUndefined();
    expect(venueOfHost("not a url")).toBeUndefined();
    expect(venueOfHost(undefined)).toBeUndefined();
  });

  it("matches app bundle ids on a dotted boundary", () => {
    expect(venueOfApp("com.robinhood.macos")).toBe("brokerage");
    expect(venueOfApp("com.robinhood")).toBe("brokerage");
    expect(venueOfApp("com.robinhoodie.app")).toBeUndefined();
    expect(venueOfApp("com.apple.mail")).toBeUndefined();
  });
});

describe("isTradeOrTransferText", () => {
  it("reads tool-name casing", () => {
    expect(isTradeOrTransferText("executeTrade", "brokerage")).toBe(true);
    expect(isTradeOrTransferText("buy_stock")).toBe(true);
    expect(isTradeOrTransferText("sellShares")).toBe(true);
  });
});
