export type AppScreen = "home" | "pay" | "request" | "activity" | "add" | "cashout" | "mint" | "operation";

export const SCREEN_TITLES: Record<AppScreen, string> = {
  home: "Wallet",
  pay: "Pay",
  request: "Request",
  activity: "Activity",
  add: "Add cash",
  cashout: "Cash out",
  mint: "Mint details",
  operation: "Operation",
};

export function primaryScreen(screen: AppScreen): "home" | "pay" | "request" | "activity" {
  if (screen === "pay" || screen === "request" || screen === "activity") return screen;
  if (screen === "operation") return "activity";
  return "home";
}
