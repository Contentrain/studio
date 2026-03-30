import { runEnterpriseRoute } from '../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('deleteWorkspaceAiKey', 'api.byoa_upgrade', event))
