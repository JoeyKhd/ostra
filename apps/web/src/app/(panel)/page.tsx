import { HomeView } from "@/components/home/home-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("home.title") };

const HomePage = () => <HomeView />;

export default HomePage;
