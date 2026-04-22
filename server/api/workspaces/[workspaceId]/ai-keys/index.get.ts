import { runEnterpriseRoute } from '../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('listWorkspaceAiKeys', 'api.byoa_upgrade', event, 'ai.byoa'))
