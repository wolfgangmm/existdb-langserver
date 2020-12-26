import { WorkspaceFolder } from "vscode";
import * as path from 'path';
import * as fs from 'fs';

export function getServerConfig(folder:WorkspaceFolder) {
	const config = path.join(folder.uri.fsPath, '.existdb.json');
	if (!fs.existsSync(config)) {
		return null;
	}
	const configData = fs.readFileSync(config, 'utf8');
	return JSON.parse(configData);
}