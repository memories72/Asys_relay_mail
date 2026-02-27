<?php

class AsysPop3FetcherPlugin extends \RainLoop\Plugins\AbstractPlugin
{
	const
		NAME     = 'asys-pop3-fetcher',
		VERSION  = '2.0',
		CATEGORY = 'General',
		DESCRIPTION = 'Injects the Agilesys POP3 Fetch Configuration panel into Webmail Settings and generates SSO Tokens.';

	public function Init() : void
	{
		// $this->addJs('js/injector_v2.js');
		$this->addAjaxHook('AsysPop3Jwt', 'AjaxAsysPop3Jwt');
	}

	public function AjaxAsysPop3Jwt()
	{
		$sEmail = '';
		$oAccount = $this->Manager()->Actions()->GetAccount();
		if ($oAccount)
		{
			$sEmail = $oAccount->Email();
		}

		if (empty($sEmail))
		{
			return $this->ajaxResponse(__FUNCTION__, array('error' => 'No active account session found'));
		}

		$header = json_encode(['typ' => 'JWT', 'alg' => 'HS256']);
		$payload = json_encode([
			'email' => $sEmail,
			'iat' => time(),
			'exp' => time() + 86400
		]);

		$base64UrlHeader = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($header));
		$base64UrlPayload = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($payload));
        
		$secret = 'agilesys_super_secret_key_2026'; 

		$signature = hash_hmac('sha256', $base64UrlHeader . "." . $base64UrlPayload, $secret, true);
		$base64UrlSignature = str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($signature));

		$jwt = $base64UrlHeader . "." . $base64UrlPayload . "." . $base64UrlSignature;

		return $this->ajaxResponse(__FUNCTION__, array(
			'jwt' => $jwt
		));
	}
}
