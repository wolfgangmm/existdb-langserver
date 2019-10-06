/**
 * Interface for the settings used for connecting to the eXist database.
 * 
 * @author Wolfgang Meier
 */
export interface ServerSettings {
	/**
	 * Base URI eXist is running on, usually "http://myserver.com/exist"
	 */
	uri: string;
	user: string;
	password: string;
	/**
	 * Database path to the installed app corresponding to this workspace,
	 * usually '/db/apps/my-app'. This is required for linting and other 
	 * capabilities to resolve imports etc.
	 */
	path?: string;
}
