// The borrower guide catalog (guide feature): one entry per task a borrower may want help with.
// Every label, condition and limitation quoted here comes from the real screens — the components
// named in each topic's steps. Topics are readable without connecting a wallet; `target` names a
// `data-guide-target` element the guide can highlight when the control is on screen.

export type GuideStep = { title: string; body: string; target?: string };
export type GuideTopic = { id: string; title: string; summary: string; steps: readonly GuideStep[] };

const WELCOME: GuideTopic = {
  id: "welcome",
  title: "Start here",
  summary: "Sign in with your crypto wallet, then pick or create a Safe.",
  steps: [
    {
      title: "Connect your wallet",
      body: 'Choose "Connect wallet" or "Sign in with wallet" and approve the sign-in in your wallet app. Signing proves you own the wallet. It is free and sends nothing.',
      target: "sign-in",
    },
    {
      title: "If no wallet is found",
      body: 'Open "How to choose a wallet" for help installing one. Reload this page, then use the wallet button to check again.',
    },
    {
      title: "What happens next",
      body: "Choose or create a Safe, the account that will hold your collateral and receive your digital dollars. You can review a loan plan before deciding whether to approve it.",
    },
  ],
};

const CHOOSE_SAFE: GuideTopic = {
  id: "choose-safe",
  title: "Choose a Safe",
  summary: "Pick which Safe the Lender agent works with, or resume a setup that stopped.",
  steps: [
    {
      title: "Open one of your Safes",
      body: 'Choose a card to open that Safe. Funded ones come first and an empty one says to add funds before borrowing. A card shows how many owners must approve when that is known, and "Address and signers" gives the details.',
      target: "choose-safe",
    },
    {
      title: "Narrow the list or resume setup",
      body: '"Show Safes on" filters the list by network. A Safe whose setup stopped offers "Finish setting up", which checks the existing setup before asking you to continue. A saved Safe notes your wallet is checked again when you open it.',
    },
    {
      title: "If yours is not listed",
      body: 'Open "Other options" to "Create a new Safe" or "Add by address". If this is the wrong wallet, "Use another wallet". If the lookup failed, "Retry" runs it again.',
    },
  ],
};

const CREATE_SAFE: GuideTopic = {
  id: "create-safe",
  title: "Create a Safe",
  summary: "Name it, choose who approves, review the cost, then set it up network by network.",
  steps: [
    {
      title: "Name it and set approvers",
      body: '"Name your Safe" takes a short label. "Who approves transactions?" offers "Just me" or "Me and people I trust", which adds co-signer fields and an "Approvals needed" count.',
    },
    {
      title: "Review before creating",
      body: 'Review lists the owners, the Safe address and the setup fee for each network you tick. The fee is covered only while sponsorship lasts, otherwise you pay it from your wallet. "Create Safe" asks for one confirmation in your wallet, which sets up the Safe and moves no money.',
      target: "create-safe",
    },
    {
      title: "Paying and resuming",
      body: 'A network can ask you to "Pay the setup fee". If a wallet prompt closed unanswered, "Check my payment" verifies it, so check wallet activity before paying again. "Leave and finish later" lets you resume from "Finish setting up" in the picker.',
    },
  ],
};

const AGENT: GuideTopic = {
  id: "agent",
  title: "Let the agent suggest transactions",
  summary: "Give the agent permission to prepare plans for your Safe owners to review.",
  steps: [
    {
      title: "What you will sign",
      body: "You add the Lender agent as a proposer on this Safe with one free signature per network. This lets it suggest transactions. This permission alone cannot spend funds.",
      target: "agent-permissions",
    },
    {
      title: "Add it network by network",
      body: '"Add Lender agent" asks you to confirm in your wallet once for each network. If one fails, "Try again" and nothing was changed on it. You can remove the agent anytime in Settings.',
    },
    {
      title: "If it cannot be added yet",
      body: 'Only networks where your wallet owns the deployed Safe are listed. Loans and the agent work on Base and Arbitrum, and "Add Base" sets one up. Chat also needs this wallet to be an owner on every lending network.',
    },
  ],
};

const OVERVIEW: GuideTopic = {
  id: "overview",
  title: "Your Safe at a glance",
  summary: "Loan health, balances, waiting approvals and how to fund the Safe.",
  steps: [
    {
      title: "Read the headline",
      body: 'The top line answers whether your loans are fine, and each loan row shows its status and how far the collateral can fall. "See fix options" opens a loan that needs action.',
    },
    {
      title: "Check the balances",
      body: '"In your Safe" totals what you can spend, what you owe and what is locked. "Estimated after closing" assumes every loan is closed, leaves out fees and moves with prices.',
      target: "overview-balances",
    },
    {
      title: "Fund the Safe",
      body: '"Add funds for collateral" gives the address for ETH or wstETH, the assets you can borrow against. When a repayment is short, "USDC repayment guidance" estimates how much more to add per network.',
    },
    {
      title: "Handle waiting approvals",
      body: "Requests still needing signatures are listed with their state and a link to act on each. Each one also opens in your Safe app.",
    },
  ],
};

const WALLET: GuideTopic = {
  id: "wallet",
  title: "Add funds to your Safe",
  summary: "Send funds to your Safe from the connected wallet or from anywhere else.",
  steps: [
    {
      title: "Open the wallet menu",
      body: "The bottom of the sidebar shows your connected wallet, its address and balances. If a different wallet is connected than the one you signed in with, it says so. Funds sent still go to your Safe.",
      target: "wallet-menu",
    },
    {
      title: "Send to your Safe",
      body: '"Send to Safe" moves ETH, wstETH or USDC where listed, from the connected wallet on a network where the Safe is set up and your wallet is an owner. "Max" keeps a little ETH in the wallet for the network fee.',
    },
    {
      title: "Or send from anywhere else",
      body: "Copy the Safe address and send from another wallet or an exchange on a listed network. Moving money out, for example to a bank, is a separate step outside this app.",
    },
  ],
};

const QUOTE: GuideTopic = {
  id: "quote",
  title: "Plan a loan",
  summary: "Get cash estimates how many digital dollars your Safe can receive, what you would lock up, and what the loan could cost.",
  steps: [
    {
      title: "Enter the amount",
      body: '"How much cash do you need?" The hint shows the range this Safe can borrow, from $10 up. Type too much and the "Use" chip applies the current maximum.',
      target: "quote-amount",
    },
    {
      title: "Review the plan",
      body: "Compare what arrives in your Safe with what you lock up. Check the estimated yearly interest and how far prices can fall before the lender could sell your collateral. Moving the proceeds to a bank is a separate step.",
      target: "quote-review",
    },
    {
      title: "Adjust under Options",
      body: 'Open "Options" to change the asset, how careful to be, how long you will keep it or the lender. Compare the original cost with the new estimate. If the plan needs to move funds first, review the extra step and cost before approving it.',
    },
    {
      title: "Approve to send it",
      body: '"Approve in your wallet" sends the plan to your Safe for the owners to approve and send. The agent must be added on that network first with one free signature. A request already waiting offers "Finish your open request" or "Start a different plan anyway".',
    },
  ],
};

const PROPOSAL: GuideTopic = {
  id: "proposal",
  title: "Review and approve a plan",
  summary: "Check what a proposal does, collect approvals, then send it.",
  steps: [
    {
      title: "Check what happens",
      body: 'The page lists what you receive and lock, the terms and the loan health after. "Steps in this transaction" shows the Safe transaction hash to compare with your wallet before approving.',
      target: "proposal-review",
    },
    {
      title: "Approve",
      body: 'The approval count tracks signatures as they come in. "Approve in your wallet" is free and sends nothing. The last approver can "Approve and send" in one step for a small network fee. Waiting on others? "Copy link" shares the request.',
    },
    {
      title: "Send it",
      body: 'Approvals alone do not run the plan. With them all in, "Send transaction" executes it, paid in ETH from the connected wallet. If a check says it cannot be sent yet, "Check again" after reviewing the latest loan and Safe state.',
    },
    {
      title: "If it fails or goes stale",
      body: 'A failed send offers "Try sending again" or "Make a new plan". An earlier Safe transaction may have to run first, and an out-of-date or replaced plan cannot run. If it still sits in the queue, reject it in your Safe app. Wrong wallet? "Switch wallet".',
    },
  ],
};

const LOAN: GuideTopic = {
  id: "loan",
  title: "Watch and manage a loan",
  summary: "Health, cost, fixes for an at-risk loan, and its on-chain details.",
  steps: [
    {
      title: "Read its health",
      body: 'The status pill and the "Checked" line say where the loan stands and when it was last read. The tiles give borrowed, collateral and interest figures, and "Health details" explains the factor. Below 1.0 the lender can sell collateral.',
      target: "loan-summary",
    },
    {
      title: "Fix an at-risk loan",
      body: 'Below your At-risk level the fix options appear: add collateral, repay with stablecoin or half of each. Greyed ones need more than the Safe holds. Pick one, review the drafted steps and "Send to Safe" for the owners to sign.',
    },
    {
      title: "Dig deeper",
      body: '"On-chain details" lists the market, the tokens and the opening transaction. "Ask the agent" takes your question to chat, and the "Proposals" panel lists what still needs signatures.',
    },
  ],
};

const REPAY: GuideTopic = {
  id: "repay",
  title: "Repay part of a loan",
  summary: "Pay down some of the debt from the loan page. The collateral stays locked.",
  steps: [
    {
      title: "Enter an amount",
      body: 'On the loan page, enter the amount you want to pay from your Safe’s available digital dollars. Check the estimated debt remaining. To repay everything and unlock collateral, use "Close this loan".',
      target: "loan-repay",
    },
    {
      title: "Send it for approval",
      body: '"Review repayment" creates a proposal. The Safe owners approve and send it like any other before the repayment runs.',
    },
    {
      title: "When it is unavailable",
      body: 'Partial repayment needs a confirmed single-asset debt, a lender that allows it and no open proposal for the loan. The reason is stated under the field. If a request may have reached Safe, "Check repayment status" before starting another.',
    },
  ],
};

const CLOSE: GuideTopic = {
  id: "close",
  title: "Close a loan",
  summary: "Repay the whole debt and get the collateral back.",
  steps: [
    {
      title: "What closing does",
      body: '"Close this loan" drafts a proposal that repays the whole debt and returns the collateral. The owners approve and send it like any other proposal before it runs.',
      target: "loan-close",
    },
    {
      title: "Fund the repayment",
      body: 'Keep enough USDC in the Safe on the same network as the loan. "USDC repayment guidance" on the overview estimates a shortfall, and accrued interest plus the signing buffer can raise it.',
    },
    {
      title: "After it runs",
      body: 'The collateral returns to the Safe and the executed proposal links the transaction. "Estimated after closing" on the overview shows what stays once every loan is closed.',
    },
  ],
};

const ALERTS: GuideTopic = {
  id: "alerts",
  title: "Alerts and early warnings",
  summary: "See where loan warnings go and when the agent last checked.",
  steps: [
    {
      title: "Where alerts appear",
      body: "Check Loan monitoring in Settings to see whether monitoring has started and when it last checked. If it detects an at-risk loan, look in chat or on the loan for available actions. One that no longer applies shows as resolved or replaced.",
    },
    {
      title: "Get alerts by email",
      body: 'In Settings, "Email alerts" takes an address and a "Send me email" tick, used only for alerts. Delivery is not configured in every deployment and checks can be delayed, so alerts may not arrive in time.',
      target: "settings-email",
    },
    {
      title: "Choose when they fire",
      body: '"Advanced risk thresholds" sets the Watch level for an early heads-up and the At-risk level that starts fix suggestions. A standing rule makes the agent draft your chosen fix inside the alert.',
    },
  ],
};

const RESERVE: GuideTopic = {
  id: "reserve",
  title: "Reserve protection",
  summary: "Set aside digital dollars in another Safe to help repay an eligible loan, up to a limit you approve.",
  steps: [
    {
      title: "What it covers",
      body: "Check the loan’s coverage on the Reserve page. For eligible Aave loans on Base, the agent can use the reserve’s USDC within your signed limits. Protection cannot guarantee that your collateral will be safe.",
      target: "reserve-protection",
    },
    {
      title: "Set it up",
      body: 'The Reserve Safe needs USDC in it and the agent added to it first. Pick a Base Safe you own or enter its address, set the daily limit and optionally the health trigger, then "Link Reserve Safe and sign". Nothing is active until its owners sign and the setup runs.',
    },
    {
      title: "Run and adjust it",
      body: 'The banner and "Used today" bar show status and use, and the limit refills each period. Every change is signed in the Reserve Safe, including turning "Agent can use reserve" off. In an alert, "Use reserve now" asks you to confirm an exact amount inside your limits.',
    },
    {
      title: "Top up or restart",
      body: 'Send USDC on Base to the Reserve Safe address to refill it. If its owners removed the agent and that removal is confirmed, "Set up protection again" drafts a fresh setup to sign. Protection stays off until it runs.',
    },
  ],
};

const ACTIVITY: GuideTopic = {
  id: "activity",
  title: "See what happened",
  summary: "The record of what the agent, you and co-signers did in this Safe.",
  steps: [
    {
      title: "Read the log",
      body: "Activity lists agent checks, proposals, signatures and reserve moves. The Actor column tells you, a co-signer, the agent and its reserve moves apart.",
      target: "activity-list",
    },
    {
      title: "Follow a row",
      body: "Each row links to the proposal, the transaction or the Safe queue. When a repayment or send conflicts with an earlier request, open Activity to find and review it.",
    },
  ],
};

const CHAT: GuideTopic = {
  id: "chat",
  title: "Ask the agent",
  summary: "Questions, plans and drafted fixes. The agent suggests, you approve.",
  steps: [
    {
      title: "Ask in plain words",
      body: '"Ask anything, or say how much you need." The agent answers, plans loans and drafts fixes for review. Review any plan it drafts before you approve it.',
      target: "chat-compose",
    },
    {
      title: "Know its limits",
      body: "Chat needs the agent added and this wallet an owner on every lending network. Until then the composer offers adding it with one free signature. Alerts, proposal cards and replies appear in the thread, and checks can be delayed.",
    },
  ],
};

const SETTINGS: GuideTopic = {
  id: "settings",
  title: "Settings",
  summary: "Monitoring, the agent's permission, rules, thresholds and the Safe's panels.",
  steps: [
    {
      title: "Agent and monitoring",
      body: '"Loan monitoring" shows whether the agent is watching. The "Lender agent" panel adds or removes it with a free signature per network. Removing stops suggestions, alerts and standing rules, while anything already waiting stays in Safe until rejected.',
    },
    {
      title: "Rules and alert levels",
      body: '"Standing rules" pick the fix the agent drafts per loan, and nothing is sent until you approve it. "Advanced risk thresholds" set the Watch and At-risk health levels and save on blur or Enter.',
    },
    {
      title: "The other panels",
      body: "Email alerts, Networks, your Safe nickname and the Reserve link live here too. Each has its own topic.",
    },
  ],
};

const NETWORKS: GuideTopic = {
  id: "networks",
  title: "Networks",
  summary: "Check where your Safe is set up and where the agent can suggest plans.",
  steps: [
    {
      title: "Check where the Safe is ready",
      body: "Check the listed networks before sending funds. A Safe address on one network does not tell you whether the Safe has been set up on another. Loans and the agent work on Base and Arbitrum.",
      target: "settings-networks",
    },
    {
      title: "Add a network and its agent",
      body: 'In Settings under "Networks", pick one under "Add a network" and confirm in your wallet. The agent needs one signature on each network where it should suggest transactions, and "Add agent" on the row provides it.',
    },
  ],
};

const NICKNAME: GuideTopic = {
  id: "nickname",
  title: "Name your Safe",
  summary: "A display nickname for this browser only. The recorded name is unchanged.",
  steps: [
    {
      title: "Set a nickname",
      body: 'In Settings, "Safe nickname" changes only what this browser shows, stored for this wallet and Safe. "Save nickname" applies it and "Use default name" goes back.',
      target: "settings-nickname",
    },
    {
      title: "Know its limits",
      body: "Co-signers, other devices and the Safe app keep showing the original name. Connect a wallet to edit the nickname.",
    },
  ],
};

export const guideTopics: readonly GuideTopic[] = [
  WELCOME,
  CHOOSE_SAFE,
  CREATE_SAFE,
  AGENT,
  OVERVIEW,
  WALLET,
  QUOTE,
  PROPOSAL,
  LOAN,
  REPAY,
  CLOSE,
  ALERTS,
  RESERVE,
  ACTIVITY,
  CHAT,
  SETTINGS,
  NETWORKS,
  NICKNAME,
];

// pathname -> topic. Dynamic segments are any non-empty segment; paths not listed get no topic.
const ROUTES: readonly { pattern: RegExp; id: string }[] = [
  { pattern: /^\/$/, id: "welcome" },
  { pattern: /^\/onboarding$/, id: "choose-safe" },
  { pattern: /^\/onboarding\/agent$/, id: "agent" },
  { pattern: /^\/s\/[^/]+$/, id: "overview" },
  { pattern: /^\/s\/[^/]+\/get-cash$/, id: "quote" },
  { pattern: /^\/s\/[^/]+\/chat$/, id: "chat" },
  { pattern: /^\/s\/[^/]+\/activity$/, id: "activity" },
  { pattern: /^\/s\/[^/]+\/reserve$/, id: "reserve" },
  { pattern: /^\/s\/[^/]+\/settings$/, id: "settings" },
  { pattern: /^\/s\/[^/]+\/loans\/[^/]+$/, id: "loan" },
  { pattern: /^\/s\/[^/]+\/proposals\/[^/]+$/, id: "proposal" },
];

/** The topic for a route, or undefined when the path has none. Query/hash and trailing slashes are ignored. */
export function topicForPath(pathname: string): GuideTopic | undefined {
  const clean = (pathname.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "") || "/";
  const route = ROUTES.find((r) => r.pattern.test(clean));
  return route ? guideTopics.find((t) => t.id === route.id) : undefined;
}
