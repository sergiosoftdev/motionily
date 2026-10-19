import { useSession } from "./session";
import { RouteName, useRoute } from "./router";
import { AppShell } from "./shell/AppShell";
import { LoginScreen } from "./screens/LoginScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { BrandScreen } from "./screens/BrandScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { PrefabsScreen } from "./screens/PrefabsScreen";
import { SoundsScreen } from "./screens/SoundsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function App() {
  const token = useSession((s) => s.token);
  const route = useRoute();

  if (!token) return <LoginScreen />;
  // The editor is full-screen; every other page lives in the sidebar shell.
  if (route.name === RouteName.Editor) return <EditorScreen key={route.id} id={route.id} />;
  // The new-video wizard is a full-screen guided flow too.
  if (route.name === RouteName.NewVideo) return <NewProjectScreen brandId={route.brandId} />;
  return (
    <AppShell route={route}>
      {route.name === RouteName.Brand && <BrandScreen key={route.id} id={route.id} tab={route.tab} />}
      {route.name === RouteName.Prefabs && <PrefabsScreen />}
      {route.name === RouteName.Sounds && <SoundsScreen />}
      {route.name === RouteName.Settings && <SettingsScreen />}
      {route.name === RouteName.Projects && <ProjectsScreen />}
    </AppShell>
  );
}
