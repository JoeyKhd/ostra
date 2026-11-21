import {
  BellIcon,
  BookOpenIcon,
  BoxIcon,
  Building2Icon,
  ChartNoAxesColumnIcon,
  CircleUserRoundIcon,
  ContainerIcon,
  CpuIcon,
  FolderIcon,
  GitPullRequestIcon,
  HardDriveIcon,
  HouseIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MailIcon,
  MonitorSmartphoneIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SlidersHorizontalIcon,
  SquareKanbanIcon,
  TicketIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
  ZapIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { ShellIcon } from "./places";

/** Each icon the shell names (`places.ts`), as its Lucide component. */
const icons: Readonly<Record<ShellIcon, LucideIcon>> = {
  house: HouseIcon,
  bell: BellIcon,
  folder: FolderIcon,
  "building-2": Building2Icon,
  settings: SettingsIcon,
  "layout-dashboard": LayoutDashboardIcon,
  "square-kanban": SquareKanbanIcon,
  "list-checks": ListChecksIcon,
  "shield-question": ShieldQuestionIcon,
  inbox: InboxIcon,
  box: BoxIcon,
  zap: ZapIcon,
  "book-open": BookOpenIcon,
  "chart-no-axes-column": ChartNoAxesColumnIcon,
  wallet: WalletIcon,
  server: ServerIcon,
  container: ContainerIcon,
  "sliders-horizontal": SlidersHorizontalIcon,
  cpu: CpuIcon,
  "git-pull-request": GitPullRequestIcon,
  ticket: TicketIcon,
  users: UsersIcon,
  "scroll-text": ScrollTextIcon,
  "circle-user-round": CircleUserRoundIcon,
  "hard-drive": HardDriveIcon,
  mail: MailIcon,
  user: UserIcon,
  "monitor-smartphone": MonitorSmartphoneIcon,
};

export const ShellIconView = ({ name, className }: { readonly name: ShellIcon; readonly className?: string }) => {
  const Icon = icons[name];
  return <Icon aria-hidden {...(className === undefined ? {} : { className })} />;
};
