import { describe, expect, it } from "vitest";
import {
  type FinancialAction,
  financialBlock,
  isNoCheckoutVenue,
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
  // review round 3: plural "transfers" is a move word again
  [
    "mercury Approve 3 transfers",
    { origin: "https://app.mercury.com", labels: ["Approve 3 transfers"] },
  ],
  ["mercury Send transfers", { origin: "https://app.mercury.com", labels: ["Send transfers"] }],
  [
    "chase Schedule transfers",
    { origin: "https://secure.chase.com", labels: ["Schedule transfers"] },
  ],
  [
    "chase dialog Confirm 3 transfers?",
    { origin: "https://secure.chase.com", labels: ["Confirm 3 transfers?"], role: "dialog" },
  ],
  [
    "chase dialog Submit these transfers now?",
    { origin: "https://secure.chase.com", labels: ["Submit these transfers now?"], role: "dialog" },
  ],
  // dialogs that start with a leave word but go on to an act
  [
    "dialog Close position and sell",
    {
      origin: "https://robinhood.com",
      labels: ["Close position and sell 10 AAPL?"],
      role: "dialog",
    },
  ],
  [
    "dialog Cancel order and sell at market",
    {
      origin: "https://robinhood.com",
      labels: ["Cancel order and sell at market?"],
      role: "dialog",
    },
  ],
  [
    "dialog Leave your note blank and transfer",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave your note blank and transfer $5,000 now?"],
      role: "dialog",
    },
  ],
  [
    "dialog Exit position? This will sell",
    {
      origin: "https://robinhood.com",
      labels: ["Exit position? This will sell 10 shares."],
      role: "dialog",
    },
  ],
  // an article word inside a flow route
  [
    "/support/transfers/confirm Confirm",
    { pageUrl: "https://secure.chase.com/support/transfers/confirm", labels: ["Confirm"] },
  ],
  [
    "/resources/…#/dashboard/transfers/confirm Confirm",
    {
      pageUrl: "https://secure.chase.com/resources/web/auth/dashboard#/dashboard/transfers/confirm",
      labels: ["Confirm"],
    },
  ],
  [
    "revolut /help#/transfer/confirm Confirm",
    { pageUrl: "https://app.revolut.com/help#/transfer/confirm", labels: ["Confirm"] },
  ],
  [
    "/transfer/new Continue",
    { pageUrl: "https://secure.chase.com/transfer/new", labels: ["Continue"] },
  ],
  // send words on P2P
  ["paypal Send invite", { origin: "https://www.paypal.com", labels: ["Send invite"] }],
  ["shop subdomain of a bank Buy", { origin: "https://shop.sofi.com", labels: ["Buy"] }],
  [
    "SBI step-up: Enter in a transaction password field on a transfer page",
    {
      pageUrl: "https://retail.onlinesbi.sbi/retail/transfer/confirm",
      labels: ["Transaction password"],
      role: "textbox",
      submits: true,
      formMethod: "post",
      formAction: "https://retail.onlinesbi.sbi/retail/transfer/confirm",
    },
  ],
  // review round 4: a listing word after an act verb excuses nothing
  [
    "mercury Approve all transfers",
    { origin: "https://app.mercury.com", labels: ["Approve all transfers"] },
  ],
  [
    "mercury Approve my transfers",
    { origin: "https://app.mercury.com", labels: ["Approve my transfers"] },
  ],
  [
    "mercury Release pending transfers",
    { origin: "https://app.mercury.com", labels: ["Release pending transfers"] },
  ],
  [
    "mercury Approve scheduled transfers",
    { origin: "https://app.mercury.com", labels: ["Approve scheduled transfers"] },
  ],
  [
    "chase Submit all transfers",
    { origin: "https://secure.chase.com", labels: ["Submit all transfers"] },
  ],
  [
    "chase Send your transfers",
    { origin: "https://secure.chase.com", labels: ["Send your transfers"] },
  ],
  [
    "dialog Approve all transfers?",
    { origin: "https://app.mercury.com", labels: ["Approve all transfers?"], role: "dialog" },
  ],
  // search-like fields on a money page
  [
    "Search on venmo /pay",
    {
      origin: "https://account.venmo.com",
      pageUrl: "https://account.venmo.com/pay",
      labels: ["Search"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://account.venmo.com/pay",
    },
  ],
  [
    "Find recipient on venmo /pay",
    {
      origin: "https://account.venmo.com",
      pageUrl: "https://account.venmo.com/pay",
      labels: ["Find recipient"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://account.venmo.com/pay",
    },
  ],
  [
    "Search payees on /transfers/new",
    {
      pageUrl: "https://secure.chase.com/transfers/new",
      labels: ["Search payees"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://secure.chase.com/transfers/new",
    },
  ],
  [
    "cash app email field posting to alerts",
    {
      pageUrl: "https://cash.app/account",
      labels: ["Email or $Cashtag"],
      role: "textbox",
      submits: true,
      formMethod: "post",
      formAction: "https://cash.app/api/alerts",
    },
  ],
  // dialogs that start with a leave phrase and go on to an act
  [
    "dialog Leave this page? We will transfer $500 now.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? We will transfer $500 now."],
      role: "dialog",
    },
  ],
  [
    "dialog Leave this page, transfer $500 first",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page, transfer $500 first"],
      role: "dialog",
    },
  ],
  [
    "dialog Close this window to send $500",
    { origin: "https://venmo.com", labels: ["Close this window to send $500"], role: "dialog" },
  ],
  [
    "dialog Log out after you sell 10 AAPL?",
    {
      origin: "https://robinhood.com",
      labels: ["Log out after you sell 10 AAPL?"],
      role: "dialog",
    },
  ],
  // signed-in routes and titles
  [
    "boa /business/transfers/wire Submit",
    { pageUrl: "https://secure.bankofamerica.com/business/transfers/wire", labels: ["Submit"] },
  ],
  [
    "revolut /us/transfer Continue",
    { pageUrl: "https://app.revolut.com/us/transfer", labels: ["Continue"] },
  ],
  ["wise /en/send Continue", { pageUrl: "https://wise.com/en/send", labels: ["Continue"] }],
  [
    "ally /personal/transfers#/send Confirm",
    { pageUrl: "https://www.ally.com/personal/transfers#/send", labels: ["Confirm"] },
  ],
  [
    "title Transfer: review, Confirm",
    { origin: "https://secure.chase.com", pageTitle: "Transfer: review", labels: ["Confirm"] },
  ],
  [
    "title Buy or sell AAPL | Robinhood, Submit",
    {
      origin: "https://robinhood.com",
      pageTitle: "Buy or sell AAPL | Robinhood",
      labels: ["Submit"],
    },
  ],
  [
    "SBI fundtransferconfirm.htm Confirm",
    { pageUrl: "https://retail.onlinesbi.sbi/retail/fundtransferconfirm.htm", labels: ["Confirm"] },
  ],
  // tabs and menus: only a one-word trade verb switches a panel
  ["tab Buy now", { origin: "https://www.coinbase.com", labels: ["Buy now"], role: "tab" }],
  ["menu Sell all", { origin: "https://robinhood.com", labels: ["Sell all"], role: "menu" }],
  // rewards: points to the bank are money
  [
    "rewards Transfer rewards to checking",
    { origin: "https://ultimaterewardspoints.chase.com", labels: ["Transfer rewards to checking"] },
  ],
  [
    "invest-travel host is not a travel site",
    { origin: "https://invest-travel.sofi.com", labels: ["Buy"] },
  ],
  [
    "lone letter x on a brokerage",
    { origin: "https://robinhood.com", labels: ["x"], role: "button" },
  ],
  // review round 5: signed-in hosts of short-named banks are not the public site
  [
    "pnc secure /en/transfers Continue",
    { pageUrl: "https://secure.pnc.com/en/transfers", labels: ["Continue"] },
  ],
  [
    "ing banking /de/ueberweisung Weiter",
    { pageUrl: "https://banking.ing.de/de/ueberweisung", labels: ["Weiter"] },
  ],
  [
    "rbc olb /us/transfer Submit",
    { pageUrl: "https://olb.rbc.com/us/transfer", labels: ["Submit"] },
  ],
  [
    "m1 dashboard /personal/transfers Continue",
    { pageUrl: "https://dashboard.m1.com/personal/transfers", labels: ["Continue"] },
  ],
  [
    "key secure /business/wire Submit",
    { pageUrl: "https://secure.key.com/business/wire", labels: ["Submit"] },
  ],
  [
    "chase www /personal/transfers/zelle Submit (a strong step)",
    { pageUrl: "https://www.chase.com/personal/transfers/zelle", labels: ["Submit"] },
  ],
  // a read verb first excuses nothing when an approval or a send follows
  [
    "View & approve transfers",
    { origin: "https://app.mercury.com", labels: ["View & approve transfers"] },
  ],
  [
    "See all transfers and approve",
    { origin: "https://app.mercury.com", labels: ["See all transfers and approve"] },
  ],
  [
    "View transfers to approve",
    { origin: "https://app.mercury.com", labels: ["View transfers to approve"] },
  ],
  [
    "All transfers: approve",
    { origin: "https://app.mercury.com", labels: ["All transfers: approve"] },
  ],
  [
    "Pending transfers - send now",
    { origin: "https://app.mercury.com", labels: ["Pending transfers - send now"] },
  ],
  [
    "Stop scheduled transfers and send now",
    { origin: "https://app.mercury.com", labels: ["Stop scheduled transfers and send now"] },
  ],
  [
    "Release my scheduled transfers",
    { origin: "https://app.mercury.com", labels: ["Release my scheduled transfers"] },
  ],
  // other languages' plurals
  [
    "de Alle Überweisungen freigeben",
    { origin: "https://www.commerzbank.de", labels: ["Alle Überweisungen freigeben"] },
  ],
  [
    "de Überweisungen ausführen",
    { origin: "https://www.commerzbank.de", labels: ["Überweisungen ausführen"] },
  ],
  [
    "es Aprobar todas las transferencias",
    { origin: "https://www.bbva.es", labels: ["Aprobar todas las transferencias"] },
  ],
  [
    "fr Valider tous les virements",
    { origin: "https://www.bnpparibas.com", labels: ["Valider tous les virements"] },
  ],
  [
    "it Approva tutti i bonifici",
    { origin: "https://www.hsbc.com", labels: ["Approva tutti i bonifici"] },
  ],
  [
    "pt Aprovar todas as transferências",
    { origin: "https://app.nubank.com.br", labels: ["Aprovar todas as transferências"] },
  ],
  // flow steps under help and support routes
  [
    "mercury /support#/transfers/approve Approve",
    { pageUrl: "https://app.mercury.com/support#/transfers/approve", labels: ["Approve"] },
  ],
  [
    "chase /help/transfers/send-now Confirm",
    { pageUrl: "https://secure.chase.com/help/transfers/send-now", labels: ["Confirm"] },
  ],
  [
    "chase #/transfer/confirm-step Confirm",
    { pageUrl: "https://secure.chase.com/web/auth/#/transfer/confirm-step", labels: ["Confirm"] },
  ],
  // dialogs
  [
    "dialog Leave this page? $500 will be transferred.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? $500 will be transferred."],
      role: "dialog",
    },
  ],
  [
    "dialog Discard draft and send $500?",
    { origin: "https://venmo.com", labels: ["Discard draft and send $500?"], role: "dialog" },
  ],
  [
    "dialog Discard unsaved changes and transfer anyway?",
    {
      origin: "https://secure.chase.com",
      labels: ["Discard unsaved changes and transfer anyway?"],
      role: "dialog",
    },
  ],
  // one letter where it can be a key
  ["brokerage B button", { origin: "https://robinhood.com", labels: ["B"], role: "button" }],
  ["single CJK 買 on a bank", { origin: "https://www.smbc.co.jp", labels: ["買"], role: "button" }],
  // review round 6: a read verb first, then a move or a trade joined on
  [
    "chase Check and transfer $500",
    { origin: "https://secure.chase.com", labels: ["Check and transfer $500"] },
  ],
  ["chase View & transfer", { origin: "https://secure.chase.com", labels: ["View & transfer"] }],
  [
    "chase See and wire $5,000",
    { origin: "https://secure.chase.com", labels: ["See and wire $5,000"] },
  ],
  [
    "robinhood Preview and buy now",
    { origin: "https://robinhood.com", labels: ["Preview and buy now"] },
  ],
  [
    "robinhood Get quote and sell",
    { origin: "https://robinhood.com", labels: ["Get quote and sell"] },
  ],
  ["coinbase View and swap", { origin: "https://www.coinbase.com", labels: ["View and swap"] }],
  ["kraken Check & deposit", { origin: "https://www.kraken.com", labels: ["Check & deposit"] }],
  [
    "mercury View transfers then approve",
    { origin: "https://app.mercury.com", labels: ["View transfers then approve"] },
  ],
  // review round 6: a listing plural, then an act verb
  [
    "de Überweisungen absenden",
    { origin: "https://www.commerzbank.de", labels: ["Überweisungen absenden"] },
  ],
  [
    "de Alle Überweisungen abschicken",
    { origin: "https://www.commerzbank.de", labels: ["Alle Überweisungen abschicken"] },
  ],
  [
    "fr Tous les virements : effectuer",
    { origin: "https://www.bnpparibas.com", labels: ["Tous les virements : effectuer"] },
  ],
  [
    "es Las transferencias pendientes: realizar",
    { origin: "https://www.bbva.es", labels: ["Las transferencias pendientes: realizar"] },
  ],
  [
    "ru Все переводы подтвердить",
    { origin: "https://www.revolut.com", labels: ["Все переводы подтвердить"] },
  ],
  [
    "mercury Pending transfers: process now",
    { origin: "https://app.mercury.com", labels: ["Pending transfers: process now"] },
  ],
  [
    "mercury Recent transfers - repeat",
    { origin: "https://app.mercury.com", labels: ["Recent transfers - repeat"] },
  ],
  [
    "mercury Scheduled transfers: run now",
    { origin: "https://app.mercury.com", labels: ["Scheduled transfers: run now"] },
  ],
  // review round 6: an exchange's own host is its app, locale or not
  [
    "coinbase www /en/withdraw-funds Next",
    { pageUrl: "https://www.coinbase.com/en/withdraw-funds", labels: ["Next"] },
  ],
  [
    "robinhood www /us/en/transfer Continue",
    { pageUrl: "https://robinhood.com/us/en/transfer", labels: ["Continue"] },
  ],
  // review round 6: money that will be sent
  [
    "dialog Your funds will be sent to John. Continue?",
    {
      origin: "https://secure.chase.com",
      labels: ["Your funds will be sent to John. Continue?"],
      role: "dialog",
    },
  ],
  [
    "dialog Discard? The payment will be sent anyway.",
    {
      origin: "https://venmo.com",
      labels: ["Discard? The payment will be sent anyway."],
      role: "dialog",
    },
  ],
  [
    "dialog $500 will be sent today",
    { origin: "https://secure.chase.com", labels: ["$500 will be sent today."], role: "dialog" },
  ],
  // #1321 follow-ups: crypto on-ramps are exchanges
  [
    "moonpay Buy now",
    { origin: "https://buy.moonpay.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "ramp Buy now",
    { origin: "https://app.ramp.network", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "transak Buy now",
    { origin: "https://global.transak.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "banxa Buy now",
    { origin: "https://checkout.banxa.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "mercuryo Buy",
    { origin: "https://exchange.mercuryo.io", labels: ["Buy"], role: "button", submits: true },
  ],
  // #1321 follow-ups: PayPal's person-to-person pages are P2P, not a checkout
  [
    "paypal.com/paypalme Pay",
    {
      pageUrl: "https://www.paypal.com/paypalme/john/50",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "paypal.com/myaccount/transfer Pay now",
    {
      pageUrl: "https://www.paypal.com/myaccount/transfer/homepage/pay",
      labels: ["Pay now"],
      role: "button",
      submits: true,
    },
  ],
  [
    "paypal.com/us/myaccount/transfer/send Pay",
    {
      pageUrl: "https://www.paypal.com/us/myaccount/transfer/send",
      labels: ["Pay $50"],
      role: "button",
      submits: true,
    },
  ],
  // #1321 follow-ups: a "not affected" clause never takes the act before it
  [
    "dialog Leave? Send $500, balance is not affected.",
    {
      origin: "https://venmo.com",
      labels: ["Leave this page? Send $500, balance is not affected."],
      role: "dialog",
    },
  ],
  [
    "dialog Leave and transfer now? Savings are not affected.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page and transfer now? Savings are not affected."],
      role: "dialog",
    },
  ],
  [
    "dialog Exit? Wire $900, others are not affected.",
    {
      origin: "https://secure.chase.com",
      labels: ["Exit this page? Wire $900, others are not affected."],
      role: "dialog",
    },
  ],
  // a bank payment sent to someone is still a move
  [
    "dialog Your payment will be sent to John on 11/20.",
    {
      origin: "https://secure.chase.com",
      labels: ["Your payment will be sent to John on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "venmo dialog Your payment will be sent on 11/20.",
    {
      origin: "https://venmo.com",
      labels: ["Your payment will be sent on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "robinhood View and sell now",
    { origin: "https://robinhood.com", labels: ["View and sell now"] },
  ],
  [
    "mercury Scheduled transfers: run now",
    { origin: "https://app.mercury.com", labels: ["Scheduled transfers: run now"] },
  ],
  // #1332 review B1: money that will be sent, whatever paper or date is named with it
  [
    "B1 Payment details: $500 will be sent to John. Confirm?",
    {
      origin: "https://secure.chase.com",
      labels: ["Payment details: $500 will be sent to John. Confirm?"],
      role: "dialog",
    },
  ],
  [
    "B1 Summary: your funds will be sent to John. OK?",
    {
      origin: "https://secure.chase.com",
      labels: ["Summary: your funds will be sent to John. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 Email confirmation: $500 will be sent to john@example.com. OK?",
    {
      origin: "https://secure.chase.com",
      labels: ["Email confirmation: $500 will be sent to john@example.com. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 $500 by email will be sent to john@example.com. OK?",
    {
      origin: "https://secure.chase.com",
      labels: ["$500 by email will be sent to john@example.com. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your receipt: $500 will be sent to John. OK?",
    {
      origin: "https://secure.chase.com",
      labels: ["Your receipt: $500 will be sent to John. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 Notice: your payment will be sent to John. OK?",
    {
      origin: "https://venmo.com",
      labels: ["Notice: your payment will be sent to John. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your money will be sent on Monday. Continue?",
    {
      origin: "https://wise.com",
      labels: ["Your money will be sent on Monday. Continue?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your payment will be sent by ACH on 11/20. Continue?",
    {
      origin: "https://app.mercury.com",
      labels: ["Your payment will be sent by ACH on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your funds will be sent on Friday. Continue?",
    {
      origin: "https://secure.chase.com",
      labels: ["Your funds will be sent on Friday. Continue?"],
      role: "dialog",
    },
  ],
  [
    "B1 $5,000 will be sent on 11/20 for John. OK?",
    {
      origin: "https://secure.chase.com",
      labels: ["$5,000 will be sent on 11/20 for John. OK?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your payment will be sent on 11/20 into John's account. Continue?",
    {
      origin: "https://secure.chase.com",
      labels: ["Your payment will be sent on 11/20 into John's account. Continue?"],
      role: "dialog",
    },
  ],
  [
    "B1 Your money will be sent on Monday. Recipient: John Smith.",
    {
      origin: "https://secure.chase.com",
      labels: ["Your money will be sent on Monday. Recipient: John Smith."],
      role: "dialog",
    },
  ],
  [
    "B1 Your crypto will be sent on 11/20. Continue?",
    {
      origin: "https://secure.chase.com",
      labels: ["Your crypto will be sent on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  // #1332 review B2: a read verb, a joiner, then a trade or move word, whatever follows
  [
    "B2 Preview and sell orders now",
    { origin: "https://robinhood.com", labels: ["Preview and sell orders now"] },
  ],
  [
    "B2 View then sell orders",
    { origin: "https://robinhood.com", labels: ["View then sell orders"] },
  ],
  [
    "B2 Check and sell orders",
    { origin: "https://robinhood.com", labels: ["Check and sell orders"] },
  ],
  ["B2 View and buy orders", { origin: "https://robinhood.com", labels: ["View and buy orders"] }],
  ["B2 View and buy prices", { origin: "https://robinhood.com", labels: ["View and buy prices"] }],
  [
    "B2 Preview and buy quote",
    { origin: "https://robinhood.com", labels: ["Preview and buy quote"] },
  ],
  ["B2 See and trade rates", { origin: "https://robinhood.com", labels: ["See and trade rates"] }],
  ["B2 View & buy chart", { origin: "https://robinhood.com", labels: ["View & buy chart"] }],
  [
    "B2 See and swap quotes",
    { origin: "https://www.coinbase.com", labels: ["See and swap quotes"] },
  ],
  [
    "B2 Get quote and buy quote",
    { origin: "https://www.coinbase.com", labels: ["Get quote and buy quote"] },
  ],
  [
    "B2 View and transfer orders",
    { origin: "https://secure.chase.com", labels: ["View and transfer orders"] },
  ],
  // #1332 review B3: a listing plural, then start
  [
    "B3 Scheduled transfers: start now",
    { origin: "https://app.mercury.com", labels: ["Scheduled transfers: start now"] },
  ],
  [
    "B3 Pending transfers: start",
    { origin: "https://app.mercury.com", labels: ["Pending transfers: start"] },
  ],
  [
    "B3 Recent transfers - start",
    { origin: "https://app.mercury.com", labels: ["Recent transfers - start"] },
  ],
  [
    "B3 Scheduled transfers start now",
    { origin: "https://app.mercury.com", labels: ["Scheduled transfers start now"] },
  ],
  [
    "B3 Pending transfers start",
    { origin: "https://app.mercury.com", labels: ["Pending transfers start"] },
  ],
  // #1332 review N2 and N3: PayPal person-to-person paths in any spelling, more on-ramps
  [
    "N2 paypal /us/en/myaccount/transfer/send Pay $50",
    {
      pageUrl: "https://www.paypal.com/us/en/myaccount/transfer/send",
      labels: ["Pay $50"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal //paypalme/john/50 Pay",
    {
      pageUrl: "https://www.paypal.com//paypalme/john/50",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /us/en/paypalme/john/50 Pay",
    {
      pageUrl: "https://www.paypal.com/us/en/paypalme/john/50",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /c2/paypalme/john Pay",
    {
      pageUrl: "https://www.paypal.com/c2/paypalme/john",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /myaccount//transfer/homepage/pay Pay now",
    {
      pageUrl: "https://www.paypal.com/myaccount//transfer/homepage/pay",
      labels: ["Pay now"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /%70aypalme/john/50 Pay",
    {
      pageUrl: "https://www.paypal.com/%70aypalme/john/50",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /myaccount/%74ransfer/send Pay",
    {
      pageUrl: "https://www.paypal.com/myaccount/%74ransfer/send",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /cgi-bin/webscr?cmd=_send-money Pay",
    {
      pageUrl: "https://www.paypal.com/cgi-bin/webscr?cmd=_send-money",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /myaccount/money/withdraw Pay",
    {
      pageUrl: "https://www.paypal.com/myaccount/money/withdraw",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /donate/?hosted_button_id=X Pay",
    {
      pageUrl: "https://www.paypal.com/donate/?hosted_button_id=X",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N2 paypal /pools/c/abc Pay",
    {
      pageUrl: "https://www.paypal.com/pools/c/abc",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  [
    "N3 crypto.link.com Buy now",
    { origin: "https://crypto.link.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 widget.wert.io Buy now",
    { origin: "https://widget.wert.io", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 alchemypay.org Buy now",
    { origin: "https://alchemypay.org", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 sardine.ai Buy now",
    { origin: "https://sardine.ai", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 app.kado.money Buy now",
    { origin: "https://app.kado.money", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 topperpay.com Buy now",
    { origin: "https://topperpay.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 utorg.pro Buy now",
    { origin: "https://utorg.pro", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 switchere.com Buy now",
    { origin: "https://switchere.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 coinify.com Buy now",
    { origin: "https://coinify.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 checkout.bitpay.com Buy now",
    { origin: "https://checkout.bitpay.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 strike.me Buy now",
    { origin: "https://strike.me", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 river.com Buy now",
    { origin: "https://river.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 swanbitcoin.com Buy now",
    { origin: "https://swanbitcoin.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 www.bitcoin.com Buy now",
    { origin: "https://www.bitcoin.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 wirexapp.com Buy now",
    { origin: "https://wirexapp.com", labels: ["Buy now"], role: "button", submits: true },
  ],
  [
    "N3 nexo.com Buy now",
    { origin: "https://nexo.com", labels: ["Buy now"], role: "button", submits: true },
  ],
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
  // review round 3
  [
    "chase search box in a same-page form",
    {
      pageUrl: "https://www.chase.com/personal",
      labels: ["Search"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://www.chase.com/personal",
    },
  ],
  [
    "ally newsletter email Enter",
    {
      origin: "https://www.ally.com",
      pageUrl: "https://www.ally.com/",
      labels: ["Email address"],
      role: "textbox",
      submits: true,
      formMethod: "post",
      formAction: "https://www.ally.com/newsletter",
    },
  ],
  ["chase × close", { origin: "https://www.chase.com", labels: ["×"], role: "button" }],
  ["chase ✕ close", { origin: "https://www.chase.com", labels: ["✕"], role: "button" }],
  [
    "rewards Transfer points",
    { origin: "https://ultimaterewardspoints.chase.com", labels: ["Transfer points"] },
  ],
  ["coinbase Buy tab", { origin: "https://www.coinbase.com", labels: ["Buy"], role: "tab" }],
  [
    "chase /personal/transfers-explained Next",
    { pageUrl: "https://www.chase.com/personal/transfers-explained", labels: ["Next"] },
  ],
  [
    "chase /personal/international-wire-transfers Continue",
    {
      pageUrl: "https://www.chase.com/personal/international-wire-transfers",
      labels: ["Continue"],
    },
  ],
  [
    "wise /us/send-money/ Continue",
    { pageUrl: "https://wise.com/us/send-money/", labels: ["Continue"] },
  ],
  [
    "chase /personal/zelle Continue",
    { pageUrl: "https://www.chase.com/personal/zelle", labels: ["Continue"] },
  ],
  [
    "wise blog article Next",
    { pageUrl: "https://wise.com/blog/how-to-transfer-money-abroad", labels: ["Next"] },
  ],
  [
    "title Wire instructions - Chase",
    { origin: "https://www.chase.com", pageTitle: "Wire instructions - Chase", labels: ["Next"] },
  ],
  [
    "title Buy vs. rent calculator | Chase",
    {
      origin: "https://www.chase.com",
      pageTitle: "Buy vs. rent calculator | Chase",
      labels: ["Next"],
    },
  ],
  [
    "title Sell your home: tips | Chase",
    {
      origin: "https://www.chase.com",
      pageTitle: "Sell your home: tips | Chase",
      labels: ["Continue"],
    },
  ],
  ["chase Recent transfers", { origin: "https://secure.chase.com", labels: ["Recent transfers"] }],
  ["chase Transfers (one word)", { origin: "https://secure.chase.com", labels: ["Transfers"] }],
  // review round 4
  [
    "chase View all transfers",
    { origin: "https://secure.chase.com", labels: ["View all transfers"] },
  ],
  [
    "chase Cancel scheduled transfers",
    { origin: "https://secure.chase.com", labels: ["Cancel scheduled transfers"] },
  ],
  [
    "dialog Discard changes to this transfer?",
    {
      origin: "https://secure.chase.com",
      labels: ["Discard changes to this transfer?"],
      role: "dialog",
    },
  ],
  [
    "wise blog money-transfer-review-2025 Next",
    { pageUrl: "https://wise.com/blog/money-transfer-review-2025", labels: ["Next"] },
  ],
  [
    "chase /personal/transfers/new-features Next",
    { pageUrl: "https://www.chase.com/personal/transfers/new-features", labels: ["Next"] },
  ],
  [
    "chase /personal/wire-transfers/how-to-start Continue",
    { pageUrl: "https://www.chase.com/personal/wire-transfers/how-to-start", labels: ["Continue"] },
  ],
  [
    "wise /learn/transfers/how-to-add-a-recipient Next",
    { pageUrl: "https://www.wise.com/learn/transfers/how-to-add-a-recipient", labels: ["Next"] },
  ],
  [
    "title Trade-in value | Chase Auto",
    {
      origin: "https://www.chase.com",
      pageTitle: "Trade-in value | Chase Auto",
      labels: ["Continue"],
    },
  ],
  [
    "title Buy a home | Chase",
    { origin: "https://www.chase.com", pageTitle: "Buy a home | Chase", labels: ["Next"] },
  ],
  [
    "chase search: What can we help you find?",
    {
      origin: "https://www.chase.com",
      pageUrl: "https://www.chase.com/",
      labels: ["What can we help you find?"],
      role: "textbox",
      submits: true,
      formMethod: "get",
      formAction: "https://www.chase.com/",
    },
  ],
  [
    "sofi newsletter email /email/subscribe?src=footer",
    {
      origin: "https://www.sofi.com",
      pageUrl: "https://www.sofi.com/",
      labels: ["Enter your email"],
      role: "textbox",
      submits: true,
      formMethod: "post",
      formAction: "https://www.sofi.com/email/subscribe?src=footer",
    },
  ],
  ["chase × with spaces", { origin: "https://www.chase.com", labels: [" × "], role: "button" }],
  [
    "travel Transfer miles to partners",
    { origin: "https://travel.chase.com", labels: ["Transfer miles to partners"] },
  ],
  ["coinbase Sell tab", { origin: "https://www.coinbase.com", labels: ["Sell"], role: "tab" }],
  [
    "shop dialog Leave this page and lose your cart?",
    {
      origin: "https://shop.example.com",
      labels: ["Leave this page and lose your cart?"],
      role: "dialog",
    },
  ],
  ["robinhood pagination 2", { origin: "https://robinhood.com", labels: ["2"], role: "button" }],
  // review round 5
  ["mercury Recent transfers", { origin: "https://app.mercury.com", labels: ["Recent transfers"] }],
  [
    "mercury Show pending transfers",
    { origin: "https://app.mercury.com", labels: ["Show pending transfers"] },
  ],
  [
    "mercury Stop all transfers",
    { origin: "https://app.mercury.com", labels: ["Stop all transfers"] },
  ],
  ["mercury See my transfers", { origin: "https://app.mercury.com", labels: ["See my transfers"] }],
  [
    "mercury Upcoming transfers",
    { origin: "https://app.mercury.com", labels: ["Upcoming transfers"] },
  ],
  [
    "mercury Your recent transfers",
    { origin: "https://app.mercury.com", labels: ["Your recent transfers"] },
  ],
  [
    "de Überweisungen (a section)",
    { origin: "https://www.commerzbank.de", labels: ["Überweisungen"] },
  ],
  [
    "de Alle Überweisungen (a list)",
    { origin: "https://www.commerzbank.de", labels: ["Alle Überweisungen"] },
  ],
  [
    "fr Mes virements (a list)",
    { origin: "https://www.bnpparibas.com", labels: ["Mes virements"] },
  ],
  ["robinhood View buy orders", { origin: "https://robinhood.com", labels: ["View buy orders"] }],
  [
    "dialog Discard this transfer?",
    { origin: "https://secure.chase.com", labels: ["Discard this transfer?"], role: "dialog" },
  ],
  [
    "dialog Leave this page? Changes to your transfer will be lost.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? Changes to your transfer will be lost."],
      role: "dialog",
    },
  ],
  ["chase www /en/zelle Next", { pageUrl: "https://www.chase.com/en/zelle", labels: ["Next"] }],
  [
    "wise /gb/send-money/ Continue",
    { pageUrl: "https://wise.com/gb/send-money/", labels: ["Continue"] },
  ],
  ["chase avatar J", { origin: "https://www.chase.com", labels: ["J"], role: "button" }],
  [
    "dialog Leave? Your transfer is not affected.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? Your transfer is not affected."],
      role: "dialog",
    },
  ],
  // #1321 follow-ups: the leave dialog and PayPal's checkout stay allowed
  [
    "dialog Leave? Funds already transferred are not affected.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? Funds already transferred are not affected."],
      role: "dialog",
    },
  ],
  [
    "paypal.com/checkoutnow Pay Now",
    {
      pageUrl: "https://www.paypal.com/checkoutnow?token=EC-1",
      labels: ["Pay Now"],
      role: "button",
      submits: true,
    },
  ],
  [
    "paypal.com/webapps/hermes Complete Purchase",
    {
      pageUrl: "https://www.paypal.com/webapps/hermes?token=EC-1",
      labels: ["Complete Purchase"],
      role: "button",
      submits: true,
    },
  ],
  [
    "paypal.com/sendgrid-lookalike is not a send path off paypal",
    {
      pageUrl: "https://www.example.com/paypalme/john",
      labels: ["Pay"],
      role: "button",
      submits: true,
    },
  ],
  // review round 6: reads, listings and the leave dialog stay allowed
  ["robinhood Check sell price", { origin: "https://robinhood.com", labels: ["Check sell price"] }],
  [
    "de Alle Überweisungen",
    { origin: "https://www.commerzbank.de", labels: ["Alle Überweisungen"] },
  ],
  ["es Mis transferencias", { origin: "https://www.bbva.es", labels: ["Mis transferencias"] }],
  ["ru Все переводы", { origin: "https://www.revolut.com", labels: ["Все переводы"] }],
  [
    "mercury Transfers in process",
    { origin: "https://app.mercury.com", labels: ["Transfers in process"] },
  ],
  ["amazon View & buy again", { origin: "https://www.amazon.com", labels: ["View & buy again"] }],
  ["gmail View and send", { origin: "https://mail.google.com", labels: ["View and send"] }],
  [
    "shop dialog Discard cart and pay?",
    { origin: "https://shop.example.com", labels: ["Discard cart and pay?"], role: "dialog" },
  ],
  [
    "dialog Leave this page? Funds already transferred are not affected.",
    {
      origin: "https://secure.chase.com",
      labels: ["Leave this page? Funds already transferred are not affected."],
      role: "dialog",
    },
  ],
  [
    "dialog A code will be sent to your phone",
    {
      origin: "https://secure.chase.com",
      labels: ["A code will be sent to your phone. Continue?"],
      role: "dialog",
    },
  ],
  [
    "wise /us/send-money/ Continue",
    { pageUrl: "https://wise.com/us/send-money/", labels: ["Continue"] },
  ],
  [
    "coinbase www /en/learn/crypto-basics Next",
    {
      pageUrl: "https://www.coinbase.com/en/learn/crypto-basics/how-to-withdraw",
      labels: ["Next"],
    },
  ],
];

/**
 * Accepted over-blocks (#1332 review): these are refused although they move no money to a person.
 * They fail closed. Every exemption tried for them reopened a real send ("…will be sent to John",
 * "View and buy orders now", "Pending transfers: start"), so they stay refused. Do not "fix" them
 * without the owner.
 */
const ACCEPTED_OVERBLOCKS: [string, FinancialAction][] = [
  [
    "bank bill pay: Your payment of $120.00 to COMCAST will be sent on 11/20.",
    {
      origin: "https://secure.chase.com",
      labels: ["Your payment of $120.00 to COMCAST will be sent on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "heading: Transfers start Monday",
    { origin: "https://app.mercury.com", labels: ["Transfers start Monday"] },
  ],
  [
    "bank bill pay: Your payment will be sent on 11/20.",
    {
      origin: "https://secure.chase.com",
      labels: ["Your payment will be sent on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "bank bill pay: Your payment will be sent to Comcast on 11/20.",
    {
      origin: "https://secure.chase.com",
      labels: ["Your payment will be sent to Comcast on 11/20. Continue?"],
      role: "dialog",
    },
  ],
  [
    "bank receipt: Your payment receipt will be sent by email.",
    {
      origin: "https://www.chase.com",
      labels: ["Your payment receipt will be sent by email. OK?"],
      role: "dialog",
    },
  ],
  [
    "bank receipt: A confirmation of your payment will be sent",
    {
      origin: "https://secure.chase.com",
      labels: ["A confirmation of your payment will be sent to your email."],
      role: "dialog",
    },
  ],
  [
    "read: See buy and sell prices",
    { origin: "https://robinhood.com", labels: ["See buy and sell prices"] },
  ],
  [
    "heading: Scheduled transfers start Monday",
    { origin: "https://app.mercury.com", labels: ["Scheduled transfers start Monday"] },
  ],
  [
    "heading: Your transfers start on Monday",
    { origin: "https://app.mercury.com", labels: ["Your transfers start on Monday"] },
  ],
];

describe("financialBlock: must block", () => {
  it.each(MUST_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeDefined();
  });
});

describe("financialBlock: accepted over-blocks (fail closed)", () => {
  it.each(ACCEPTED_OVERBLOCKS)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeDefined();
  });
});

describe("financialBlock: must not block", () => {
  it.each(MUST_NOT_BLOCK)("%s", (_name, a) => {
    expect(financialBlock(a)).toBeUndefined();
  });
});

describe("isNoCheckoutVenue: where the Link purchase tool never pays", () => {
  it.each([
    "https://www.coinbase.com/buy",
    "https://robinhood.com",
    "https://venmo.com/pay",
    "https://cash.app",
    "https://secure.chase.com/web/auth",
    "https://buy.moonpay.com",
    "https://app.ramp.network/buy",
    "https://global.transak.com",
    "https://www.paypal.com/paypalme/john",
    "https://www.paypal.com/myaccount/transfer/homepage/pay",
    "https://www.paypal.com/en/send",
    "https://crypto.link.com",
    "https://www.paypal.com/us/en/myaccount/transfer/send",
    "https://www.paypal.com//paypalme/john/50",
    "https://www.paypal.com/cgi-bin/webscr?cmd=_send-money",
    "https://www.paypal.com/paypal.me/john",
    "https://www.paypal.com/pool/abc",
    "https://www.paypal.com/pay?to=john",
    "https://www.paypal.com/donate/?hosted_button_id=X",
    "https://www.swapped.com",
    // #1332 follow-up: one malformed escape, double encoding, suffixes and hash routes.
    "https://www.paypal.com/%70aypalme/john/%ZZ",
    "https://www.paypal.com/%70aypalme/john/%",
    "https://www.paypal.com/cgi-bin/webscr?cmd=_send-money%",
    "https://www.paypal.com/cgi-bin/webscr?x=%ZZ&cmd=_send-money",
    "https://www.paypal.com/%2570aypalme/john",
    "https://www.paypal.com/paypalme;x/john",
    "https://www.paypal.com/paypalme./john",
    "https://www.paypal.com/paypalme%20/john",
    "https://www.paypal.com/#/paypalme/john",
    "https://www.paypal.com/us/#/%70aypalme/john/%ZZ",
    "https://www.paypal.com/#/myaccount/transfer/send",
    "https://www.paypal.com/#/pools/abc",
    // #1345 follow-up: hash forms #1342 read as P2P.
    "https://www.paypal.com/#paypalme/john",
    "https://www.paypal.com/#!/paypalme/john",
    "https://www.paypal.com/#!paypalme/john",
    "https://www.paypal.com/#/us/paypalme/john",
    "https://www.paypal.com/#/us/en/paypalme/john",
    "https://www.paypal.com/#/c2/paypalme/john",
    "https://www.paypal.com/#/c2/myaccount/transfer/send",
    "https://www.paypal.com/myaccount#/transfer/send",
    "https://www.paypal.com/myaccount/#/money",
    "https://www.paypal.com/us/myaccount/#/money",
    "https://www.paypal.com/#/send-money",
    "https://www.paypal.com/#/sendmoney/john",
    "https://www.paypal.com/checkoutnow?token=EC-1#/send-money",
    // #1345 follow-up: a decoded `#` or `?` ends a segment, as `;` does.
    "https://www.paypal.com/#/send-money%23/x",
    "https://www.paypal.com/%70aypalme%23/john",
    "https://www.paypal.com/#/paypalme?x=1",
    "https://www.paypal.com/#/paypalme%3F/john",
  ])("%s has no checkout", (url) => {
    expect(isNoCheckoutVenue(url)).toBe(true);
  });
  it.each([
    "https://shop.example.com/checkout",
    "https://www.paypal.com/checkoutnow",
    "https://www.paypal.com/webapps/hermes?token=EC-1",
    "https://www.paypal.com/myaccount/summary",
    "https://link.com",
    "https://www.paypal.com/ncp/payment/ABC",
    "https://www.paypal.com/invoice/p/ABC",
    "https://www.paypal.com/cgi-bin/webscr?cmd=_xclick",
    "https://www.paypal.com/sendgrid",
    "https://www.paypal.com/checkoutnow?token=EC-1&x=%",
    "https://www.paypal.com/checkoutnow?token=%ZZ",
    "https://www.paypal.com/webapps/hermes?token=EC-1&return=%",
    "https://www.paypal.com/checkout/?token=100%",
    "https://www.paypal.com/checkout/#/review",
    // #1342 follow-up: bare hash words of a checkout step are not P2P routes.
    "https://www.paypal.com/checkoutnow?token=EC-1#/pay",
    "https://www.paypal.com/checkoutnow?token=EC-1#pay",
    "https://www.paypal.com/checkoutnow?token=EC-1#/send-otp",
    "https://www.paypal.com/checkoutweb/signup?token=EC-1#/send-otp",
    "https://www.paypal.com/authflow/twofactor/#/send-code",
    "https://www.paypal.com/checkout/otp/#/checkout/otp/send",
    "https://www.paypal.com/checkoutnow?token=EC-1#send",
    "https://www.paypal.com/checkoutnow?token=EC-1#/us/pay",
    "https://www.paypal.com/checkoutnow?token=EC-1#!/send-otp",
    "https://www.paypal.com/checkoutnow?token=EC-1#/c2/send-code",
    "https://www.paypal.com/checkoutnow?token=EC-1#/send-money-otp-not-money",
    "https://www.paypal.com/myaccount/summary#/transfer/send",
    "https://www.paypal.com/myaccount#/summary",
    "https://www.paypal.com/myaccount#/pay",
    // #1345 follow-up: hash query values are not routes.
    "https://www.paypal.com/checkoutnow?token=EC-1#/checkout/review?returnUrl=%2Fmyaccount%2Fmoney",
    "https://www.paypal.com/checkoutnow?token=EC-1#/checkout/review?ref=/donate",
    "https://www.paypal.com/checkoutnow?token=EC-1#?next=/paypalme/john",
    "https://www.paypal.com/webapps/hermes#/checkout/login?cancel=https://shop.example/pool",
    "https://www.amazon.com/gp/buy",
    "https://ultimaterewardspoints.chase.com/travel",
    undefined,
  ])("%s may check out", (url) => {
    expect(isNoCheckoutVenue(url)).toBe(false);
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
