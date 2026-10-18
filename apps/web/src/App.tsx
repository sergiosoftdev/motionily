import { useSession } from "./session";
import { RouteName, useRoute } from "./router";
import { LoginScreen } from "./screens/LoginScreen";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { NewProjectScreen } from "./screens/NewProjectScreen";
import { EditorScreen } from "./screens/EditorScreen";

export function App() {
  const token = useSession((s) => s.token);
  const route = useRoute();

  if (!token) return <LoginScreen />;
  switch (route.name) {
    case RouteName.NewProject:
      return <NewProjectScreen />;
    case RouteName.Editor:
      return <EditorScreen key={route.id} id={route.id} />;
    case RouteName.Projects:
      return <ProjectsScreen />;
  }
}
