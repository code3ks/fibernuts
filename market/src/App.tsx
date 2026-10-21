import { useState } from "react";

import { fmt } from "@wallet-lib/wallet";

import { Shell, type AttendeeScreen, type MarketScreen, type VendorScreen } from "./components/Shell";
import { EVENT } from "./event/manifest";
import { useMarket } from "./hooks/useMarket";
import { AttendeeActivity } from "./screens/AttendeeActivity";
import { AttendeeEvent } from "./screens/AttendeeEvent";
import { AttendeePay } from "./screens/AttendeePay";
import { CashScreen, type CashMode } from "./screens/CashScreen";
import { VendorOrder } from "./screens/VendorOrder";
import { VendorOrders } from "./screens/VendorOrders";
import { VendorSell } from "./screens/VendorSell";

const role = window.location.pathname === "/vendor" || window.location.pathname.startsWith("/vendor/") ? "vendor" : "attendee";

export default function App() {
  const market = useMarket(role);
  const [attendeeScreen, setAttendeeScreen] = useState<AttendeeScreen>("event");
  const [vendorScreen, setVendorScreen] = useState<VendorScreen>("sell");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [cashEntry, setCashEntry] = useState<{ mode: CashMode; key: number }>({ mode: "overview", key: 0 });
  const screen: MarketScreen = role === "attendee" ? attendeeScreen : vendorScreen;
  const openCash = (mode: CashMode) => {
    setCashEntry((current) => ({ mode, key: current.key + 1 }));
    if (role === "attendee") setAttendeeScreen("cash");
    else setVendorScreen("cash");
    window.scrollTo({ top: 0, behavior: "auto" });
  };
  const showBalanceClaim = role === "attendee" && market.balance === 0;
  const claimAmount = market.faucetConfig ? fmt(market.faucetConfig.amount) : null;
  const balanceAction = showBalanceClaim ? {
    label: market.faucetStatus === "loading"
      ? "Checking test RUSD"
      : claimAmount
        ? `Claim ${claimAmount} test RUSD`
        : "Claim test RUSD",
    onClick: () => openCash("claim"),
    busy: market.faucetStatus === "loading",
    disabled: market.faucetStatus !== "available" || market.status !== "online" || Boolean(market.storageError) || market.preview,
    title: ["paused", "unavailable"].includes(market.faucetStatus)
      ? market.faucetError ?? "Community claims are unavailable right now."
      : undefined,
  } : undefined;
  const navigate = (next: MarketScreen) => {
    if (next === "cash") {
      openCash("overview");
      return;
    }
    if (role === "attendee" && ["event", "pay", "cash", "activity"].includes(next)) setAttendeeScreen(next as AttendeeScreen);
    if (role === "vendor" && ["sell", "order", "orders", "cash"].includes(next)) setVendorScreen(next as VendorScreen);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  let content;
  if (role === "attendee") {
    if (attendeeScreen === "event") content = <AttendeeEvent market={market} onPay={() => navigate("pay")} onCash={() => openCash("overview")} onClaim={() => openCash("claim")} />;
    else if (attendeeScreen === "pay") content = <AttendeePay market={market} onDone={() => navigate("event")} />;
    else if (attendeeScreen === "cash") content = <CashScreen key={`attendee-cash-${cashEntry.key}`} market={market} initialMode={cashEntry.mode} />;
    else content = <AttendeeActivity market={market} />;
  } else if (vendorScreen === "sell") {
    content = <VendorSell market={market} onOrder={(order) => { setSelectedOrderId(order.id); navigate("order"); }} />;
  } else if (vendorScreen === "order") {
    content = <VendorOrder market={market} orderId={selectedOrderId} onNewSale={() => navigate("sell")} />;
  } else if (vendorScreen === "orders") {
    content = <VendorOrders market={market} onOpen={(id) => { setSelectedOrderId(id); navigate("order"); }} />;
  } else {
    content = <CashScreen key={`vendor-cash-${cashEntry.key}`} market={market} initialMode={cashEntry.mode} />;
  }

  return (
    <Shell
      role={role}
      screen={screen}
      status={market.status}
      mintName={market.profile?.name ?? new URL(EVENT.mintUrl).host}
      balance={fmt(market.balance)}
      balanceAction={balanceAction}
      toast={market.toast}
      onNavigate={navigate}
    >
      {content}
    </Shell>
  );
}
