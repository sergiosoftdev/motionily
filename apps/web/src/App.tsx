import { useSession } from "./session";
import { RouteName, useRoute } from "./router";
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
  // The editor is full-screen; every other page draws its own MotionilyLayout.
  if (route.name === RouteName.Editor) return <EditorScreen key={route.id} id={route.id} />;
  // The new-video wizard is a full-screen guided flow too.
  if (route.name === RouteName.NewVideo) return <NewProjectScreen brandId={route.brandId} />;
  if (route.name === RouteName.Brand) return <BrandScreen key={route.id} id={route.id} tab={route.tab} />;
  if (route.name === RouteName.Prefabs) return <PrefabsScreen />;
  if (route.name === RouteName.Sounds) return <SoundsScreen />;
  if (route.name === RouteName.Settings) return <SettingsScreen />;
  return <ProjectsScreen />;
}
