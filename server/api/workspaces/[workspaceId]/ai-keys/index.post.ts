import { runEnterpriseRoute } from '../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('createWorkspaceAiKey', 'api.byoa_upgrade', event))
