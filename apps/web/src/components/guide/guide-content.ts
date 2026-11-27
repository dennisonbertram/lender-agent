// The borrower guide catalog (guide feature): one entry per task a borrower may want help with.
// Every label, condition and limitation quoted here comes from the real screens — the components
// named in each topic's steps. Topics are readable without connecting a wallet; `target` names a
// `data-guide-target` element the guide can highlight when the control is on screen.

export type GuideStep = { title: string; body: string; target?: string };
export type GuideTopic = { id: string; title: string; summary: string; steps: readonly GuideStep[] };

const localDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
const demoFunds = "This demo uses simulated funds. Never send real money to a demo Safe.";

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
      body: "Choose “Add Lender agent” and confirm in your wallet for each listed network. If confirmation fails, check the agent’s status on that network before trying again. You can remove it in Settings.",
    },
    {
      title: "If it cannot be added yet",
      body: "The agent works on Base and Arbitrum. “Add Base” records the network and checks whether the Safe already exists there — it does not deploy the Safe. You can grant permission once the Safe is set up and your wallet is an owner.",
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
      body: localDemo ? demoFunds : "“Add funds for collateral” shows where this Safe accepts ETH or wstETH. For repayment, “USDC repayment guidance” estimates the shortfall on the loan’s network.",
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
      body: localDemo ? "Wallet transfers are turned off in this demo. Explore the Safe using its simulated balance." : "In the wallet menu, choose “Send to Safe”, pick the asset and network, and enter an amount. Review the fee and destination before confirming in your wallet.",
    },
    {
      title: "Or send from anywhere else",
      body: localDemo ? demoFunds : "To deposit from another wallet or exchange, copy your Safe address and choose a network where the Safe is already set up. Moving money to a bank is a separate step outside this app.",
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
      body: localDemo ? "Enter the digital dollars you want to receive. If there’s no amount field, retry the balance check or use a funded network. Never send real money to a demo Safe." : "Enter the digital dollars you want to receive. If there’s no amount field, follow the message to retry a balance check, use a funded network, or add eligible collateral.",
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
      body: "Read “What happens” before approving and compare the Safe transaction hash with your wallet — when you can sign it is shown in that section, otherwise under “Technical details”.",
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
      body: "If sending fails, follow the option to retry or make a new plan. An older or replaced request may still be executable from your Safe. Check the Safe queue and reject an unwanted request there before proceeding.",
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
      body: "On eligible Base loans the fix options appear below your At-risk level: add collateral, repay with stablecoin, or half of each. A choice can be unavailable when the Safe is short, the agent is off, or a request is in progress. Pick one, review the drafted steps and “Send to Safe” for the owners to sign.",
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
      body: 'On the loan page, enter the amount you want to pay from your Safe’s available digital dollars and check the estimated debt remaining. The field and "Close this loan" appear only on a watched loan with a single collateral asset and a confirmed debt.',
      target: "loan-repay",
    },
    {
      title: "Send it for approval",
      body: '"Review repayment" creates a proposal. The Safe owners approve and send it like any other before the repayment runs.',
    },
    {
      title: "When it is unavailable",
      body: 'When the field shows but repayment is off, the reason is stated under it — the lender may not allow it or a proposal may be open for the loan. If a request may have reached Safe, "Check repayment status" before starting another.',
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
      body: '"Close this loan" — shown only on a watched loan with a single collateral asset and a confirmed debt — drafts a proposal that repays the whole debt and returns the collateral. The owners approve and send it like any other proposal before it runs.',
      target: "loan-close",
    },
    {
      title: "Fund the repayment",
      body: localDemo ? "Use “USDC repayment guidance” on Overview to explore the estimated shortfall with simulated funds. Never send real money to a demo Safe." : "Use “USDC repayment guidance” on Overview to check the estimated shortfall on the loan’s network. Interest can change the final amount needed.",
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
      body: "Turning protection off stops the app from using the reserve immediately. Its spending permission remains until the owners execute the removal in the Reserve Safe. On an eligible alert, an owner of both Safes can choose “Use reserve now”. Confirming the amount submits it under the existing limit, without another signature.",
    },
    {
      title: "Top up or restart",
      body: localDemo ? "Use simulated reserve funds in the demo. After a removal is confirmed, “Set up protection again” lets the owners review the limits and approve a fresh setup. Never send real money to a demo Safe." : "Top up the Reserve Safe with USDC on Base. After a removal is confirmed, choose “Set up protection again”, review the limits, and get fresh owner approval. Protection restarts when setup runs.",
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
      body: "Some rows have a proposal, transaction, or Safe queue link. A status update can stand on its own. Look here for an earlier request if a new repayment or send is waiting on it.",
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
      body: "If chat asks for another owner, sign in with a wallet that owns this Safe on every tracked lending network. An eligible owner can read the thread. Add the agent before sending a new message.",
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
      body: "Email alerts, Networks, your Safe nickname and the Reserve link live here too — the Reserve link moves to the sidebar once the Safe has an Aave loan or a linked Reserve. Each has its own topic.",
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
      body: localDemo ? "Explore the listed networks with simulated balances. Never send real money to a demo Safe." : "Check the listed networks before sending funds. A Safe address on one network does not tell you where else the Safe is set up. Loans and the agent work on Base and Arbitrum.",
      target: "settings-networks",
    },
    {
      title: "Add a network and its agent",
      body: "In Settings, “Add a network” records the network and checks whether the Safe already exists there — it does not deploy the Safe. Once the Safe is set up and your wallet is an owner, select “Add agent” if you want suggestions there.",
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
  const queryIndex = pathname.indexOf("?");
  const hashIndex = pathname.indexOf("#");
  const suffixStart = Math.min(
    queryIndex === -1 ? pathname.length : queryIndex,
    hashIndex === -1 ? pathname.length : hashIndex,
  );
  let clean = pathname.slice(0, suffixStart);
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  if (clean === "") clean = "/";
  const route = ROUTES.find((r) => r.pattern.test(clean));
  return route ? guideTopics.find((t) => t.id === route.id) : undefined;
}
