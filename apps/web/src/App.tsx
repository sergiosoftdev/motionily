import { useSession } from "./session";
import { RouteName, useRoute } from "./router";
import { LandingScreen } from "./landing/LandingScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { BrandScreen } from "./screens/BrandScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { PrefabsScreen } from "./screens/PrefabsScreen";
import { SoundsScreen } from "./screens/SoundsScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { StatsScreen } from "./screens/StatsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { CalendarScreen } from "./screens/CalendarScreen";
import { DueReminders } from "./posts/DueReminders";
import { DesktopBridge } from "./native/DesktopBridge";

export function App() {
  const token = useSession((s) => s.token);
  const route = useRoute();

  // Signed out: the public landing page, with its (mock) sign-in.
  if (!token || route.name === RouteName.Welcome) return <LandingScreen />;
  return (
    <>
      <Screen />
      <DueReminders />
      <DesktopBridge />
    </>
  );
}

function Screen() {
  const route = useRoute();
  // The editor is full-screen; every other page draws its own MotionilyLayout.
  if (route.name === RouteName.Editor) return <EditorScreen key={route.id} id={route.id} />;
  // The new-video wizard is a full-screen guided flow too.
  if (route.name === RouteName.NewVideo) return <NewProjectScreen brandId={route.brandId} />;
  if (route.name === RouteName.Brand) return <BrandScreen key={route.id} id={route.id} tab={route.tab} />;
  if (route.name === RouteName.Calendar) return <CalendarScreen postId={route.postId} />;
  if (route.name === RouteName.Stats) return <StatsScreen />;
  if (route.name === RouteName.Prefabs) return <PrefabsScreen />;
  if (route.name === RouteName.Sounds) return <SoundsScreen />;
  if (route.name === RouteName.Library) return <LibraryScreen />;
  if (route.name === RouteName.Settings) return <SettingsScreen />;
  return <ProjectsScreen />;
}
