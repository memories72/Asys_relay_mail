$(function () {
    var checkExist = setInterval(function () {
        var leftMenuContent = document.querySelector('.b-settins-left .b-content.thm-settings-menu') || document.querySelector('.b-admin-menu');

        if (leftMenuContent && !document.getElementById('pop3-fetch-tab')) {
            var anchor = document.createElement('a');
            anchor.id = 'pop3-fetch-tab';
            anchor.href = '#';
            anchor.className = 'e-item selectable';
            anchor.style.cssText = 'margin-top:15px; text-align:center; background:#0ea5e9; color:white; font-weight:bold; border-radius:5px; padding:10px; display:block; text-decoration:none; margin-left:10px; margin-right:10px; transition: all 0.2s;';
            anchor.innerHTML = '<span class="e-link" style="color:white;"><i class="icon-download" style="margin-right:8px; color:white;"></i> POP3 외부 설정</span>';

            if (leftMenuContent.className.indexOf('b-admin-menu') !== -1) {
                leftMenuContent.parentNode.appendChild(anchor);
            } else {
                leftMenuContent.appendChild(anchor);
            }

            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                if (document.getElementById('pop3-overlay')) return;

                var iframeUrl = 'http://localhost:13000';

                function openOverlay(url) {
                    var overlay = document.createElement('div');
                    overlay.id = 'pop3-overlay';
                    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; z-index:2147483647; background:rgba(2, 6, 23, 0.85); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px);';

                    var inner = document.createElement('div');
                    inner.style.cssText = 'position:relative; width:95%; max-width:1200px; height:90%; border-radius:12px; overflow:hidden; background:transparent;';

                    var closeBtn = document.createElement('button');
                    closeBtn.id = 'closePop3OverlayBtn';
                    closeBtn.innerHTML = '×';
                    closeBtn.style.cssText = 'position:absolute; top:20px; right:20px; width:45px; height:45px; border-radius:50%; border:none; background:rgba(255,255,255,0.1); color:white; font-size:30px; cursor:pointer; z-index:10; line-height:1; padding-bottom:4px; margin:0;';
                    closeBtn.onmouseover = function () { this.style.background = 'rgba(239, 68, 68, 0.9)'; };
                    closeBtn.onmouseout = function () { this.style.background = 'rgba(255,255,255,0.1)'; };

                    var iframe = document.createElement('iframe');
                    iframe.src = url;
                    iframe.style.cssText = 'width:100%; height:100%; border:none; background:transparent;';

                    inner.appendChild(closeBtn);
                    inner.appendChild(iframe);
                    overlay.appendChild(inner);
                    document.body.appendChild(overlay);

                    closeBtn.addEventListener('click', function () {
                        overlay.remove();
                    });
                }

                if (window.rl && window.rl.pluginAjax) {
                    var originalHtml = anchor.innerHTML;
                    anchor.innerHTML = '<span class="e-link" style="color:white;">인증 연동 중...</span>';

                    window.rl.pluginAjax('AsysPop3Jwt', {}, function (iError, oData) {
                        anchor.innerHTML = originalHtml;
                        console.log("SSO PluginAjax Response:", { iError: iError, oData: oData });

                        if (oData && oData.Result && oData.Result.jwt) {
                            console.log("SSO Success! JWT:", oData.Result.jwt);
                            openOverlay(iframeUrl + '/?jwt=' + oData.Result.jwt);
                        } else {
                            console.error("SSO Token 발급 실패! 관리자 문의 필요. 상세:", oData);
                            alert("SSO 실패: 콘솔 로그를 확인하세요.");
                            // openOverlay(iframeUrl); // DO NOT OPEN OVERLAY ON FAILURE
                        }
                    });
                } else {
                    console.error('플러그인 AJAX 모듈 에러: rl.pluginAjax 없음', window.rl);
                    alert("SSO 실패: 플러그인 로드 에러");
                    // openOverlay(iframeUrl); // DO NOT OPEN OVERLAY ON FAILURE
                }
            });
        }
    }, 1000);
});
